# react-ops-console

An incident console built contract-first: a Protobuf API checked by `buf`, a Node server speaking ConnectRPC with SQLite storage, and a React 19 front end using TanStack Query. Live timeline updates stream from the server, and two people editing the same incident can't silently overwrite each other.

Status: built step by step, locally. Not published.

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
