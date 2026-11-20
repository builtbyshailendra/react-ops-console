# react-ops-console

[![ci](https://github.com/builtbyshailendra/react-ops-console/actions/workflows/ci.yml/badge.svg)](https://github.com/builtbyshailendra/react-ops-console/actions/workflows/ci.yml)

An incident console built contract-first: a Protobuf API checked by `buf`, a Node server speaking ConnectRPC with SQLite storage, and a React 19 front end using TanStack Query. Live timeline updates stream from the server, and two people editing the same incident can't silently overwrite each other.

Status: built step by step. Published 20 Nov 2026; CI runs the contract, server and browser tests on every push.

Learning notes: [LEARN.md](LEARN.md). Interview brief: `../briefs/react-ops-console.md`.

## Build log

### Step 1: the contract

`proto/ops/v1/incidents.proto` is the single source of truth: incidents, timeline events, and an `IncidentService` with list (filters, page tokens), get, acknowledge, update status, add note, and a server-streaming `WatchTimeline`. Reads are marked `NO_SIDE_EFFECTS` so Connect can send them as cacheable GETs. Updates carry the `version` the client read; a stale version will be refused.

`buf generate` (buf 1.75 with protoc-gen-es 2.17) writes TypeScript used by both the server and the browser; `buf lint` checks the standard style rules.

`test/contract.test.ts` makes six breaking edits and two additive ones to a copy of the contract and checks what `buf breaking` says: renaming a field, changing a type, deleting a field, renumbering, renaming an enum value and removing an RPC are refused; a new field and a new RPC are allowed.

What broke: I first set the breaking-change category to `WIRE_JSON`. The test showed it **allowed removing an RPC**: wire categories only judge how messages are encoded, and an RPC isn't a message. A client calling it would fail at runtime. Switched to `FILE`, the strictest category, which also covers generated code and services.

Also broke: the generated code used TypeScript `enum`s. Node runs `.ts` files by stripping types, and an `enum` isn't a type: it produces runtime code, so `tsc` (with `erasableSyntaxOnly`) refused it (TS1294). The fix is the plugin option `erasable_syntax=true`, which generates `as const` objects instead. Same values (`Status.RESOLVED` is still 4), and Node can now import the generated file with no build step.

Note: npm held back `@bufbuild/buf`'s install script for review; buf works without it, so it stays unapproved.

### Step 2: the server

`server/` is plain TypeScript that Node 26 runs directly (`node server/main.ts`, no build): `connectNodeAdapter` serves the API on one HTTP/1.1 port (Connect protocol and gRPC-Web, so a browser needs no proxy), and the same port serves the built React app. Storage is `node:sqlite`, Node's built-in SQLite, with WAL.

The rules, each one a Connect error code a client can act on:

| Rule | Code |
| --- | --- |
| No token, or an unknown one | `Unauthenticated` |
| A viewer tries to change something | `PermissionDenied` |
| Acknowledge an incident that isn't triggered; move status backwards | `FailedPrecondition` |
| Write with a `version` someone else already moved past | `Aborted` |
| Empty note, page size over 100, a page token the server didn't issue | `InvalidArgument` |
| Unknown incident | `NotFound` |
| A timeline subscriber more than 500 events behind | `ResourceExhausted` |

- **Lost updates:** every write is `UPDATE ... WHERE id = ? AND version = ?`. Zero rows changed means someone else got there first, so the second writer is told to reload instead of overwriting.
- **Paging:** keyset on `(opened_at, id)`, newest first, fetching one extra row to know whether a next page exists. The token is that cursor in base64url; clients treat it as opaque.
- **Live timeline:** `WatchTimeline` subscribes to an in-process event bus *before* reading history, so an event that lands in between is buffered, not missed, and a seen-id set drops the duplicate.

`test/server.test.ts` (11 tests) runs a real Connect client against the handlers: auth and roles, walking all 60 seeded incidents in pages of 7 (each once, in order), filters, acknowledge, the two-responder conflict, forward-only status, note validation, and streaming. Two tests start the real HTTP server: a note from one client arrives on another client's stream, and when the watcher disconnects the server drops its subscriber. Also: the static file server can't be walked out of with `..%2f`.

What broke: the "subscriber is removed when the client leaves" test failed on the in-memory transport. A probe showed why: that transport only runs the handler when the client asks for the next message, so an abandoned stream just stays paused at a `yield`, and over real HTTP the adapter cleans it up fine (0 listeners). The leak check moved to the HTTP test. The probe also exposed a real gap: a client that stays connected but **stops reading** would make the server buffer events forever. The buffer is now capped at 500; past that the server unsubscribes and ends the stream with `ResourceExhausted`, and the client reconnects and gets the full history.

### Step 3: the React app

`web/` is React 19 with TanStack Query through `@connectrpc/connect-query`, so every query and mutation is typed from the contract. Run it with `npm run build && npm start` and open http://127.0.0.1:8098 (or `npm run dev` for Vite on 5173, proxying the API to 8098).

- **List:** `useInfiniteQuery` with `pageToken` as the page param; "Load more" fetches the next page; status and severity filters; `keepPreviousData` so rows stay while a new filter loads. The list polls every 15 s; only the open incident streams.
- **Detail:** acknowledge, mark mitigated, resolve, and notes. Status changes are **optimistic**: the new status shows at once, and if the server says no, the old one is put back and the reason is shown.
- **Live timeline:** `useTimeline` reads `WatchTimeline` with `for await`, reconnects with backoff (0.5 s up to 8 s), merges by event id so the replayed history never shows twice, and closes the stream on unmount.
- **Knowing when it's stale:** each event carries the incident version it produced (an additive contract change, which `buf breaking` accepted). If that's newer than the version on screen, the page refetches. No clock comparison.
- **Errors by code:** `Aborted` becomes "someone else changed this incident; you now see the latest version", `FailedPrecondition` shows the server's reason, and `PermissionDenied` and `Unauthenticated` each get a plain sentence. Queries don't retry errors that can't succeed on a retry.
- Reads (`NO_SIDE_EFFECTS` in the contract) go out as GET; the browser pane's network log confirmed it.

Checked in the browser pane with two tabs, asha and ravi, on the same incident. Asha acknowledged and posted a note; ravi's tab showed both events, then refetched to Acknowledged / asha / version 2 without a click. No console errors.

What broke: the timeline rows were unevenly spaced. Each row's class was the event kind, and the kinds `note` and `status` are also the class names of the note form and the status badge, so those rows picked up the wrong margins. Event classes are now prefixed (`ev-note`).

### Step 4: end-to-end tests

`e2e/console.spec.ts`, Playwright 1.65 on the installed Microsoft Edge (`channel: 'msedge'`, no browser download), against the real built server with an in-memory database. 6 tests:

1. A viewer sees the incident but no buttons and no note form.
2. Filters and Load more (15, then 30; "SEV1 only" shows only SEV1).
3. Asha acknowledges and posts a note; ravi's page updates without being touched (`results/live-update-ravi.png`).
4. **The conflict:** ravi's stream is cut, asha marks the incident mitigated, ravi clicks Resolve on his stale copy. The server answers `Aborted`, the optimistic "Resolved" is rolled back, the message shows, and his view reloads to Mitigated. His second click works (`results/conflict-ravi.png`).
5. A cut stream shows "Reconnecting...", misses a note, then reconnects and shows it, with no duplicate rows.
6. Phone width in dark mode: one column, no sideways scroll (`results/phone-dark-detail.png`).

What broke: `route()` only blocks new requests, so blocking `WatchTimeline` did nothing to a stream that was already open. The test helper now blocks, then reloads the page. Also `getByRole('button', { name: 'Acknowledge' })` matched list rows that say "Acknowledged"; the action buttons are matched exactly.

## Run it

```
npm install
npm run generate      # Protobuf -> TypeScript
npm test              # 19 tests: contract (8) and server (11)
npm run build && npm start    # http://127.0.0.1:8098, demo users asha, ravi, guest
npm run e2e           # 6 Playwright tests on Edge
```
