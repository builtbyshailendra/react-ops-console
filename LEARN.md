# Learning notes: react-ops-console

## 1. Contract-first APIs in five minutes

You write the API once as a **Protobuf** file (`.proto`): messages (the data) and a service (the calls). A code generator turns it into typed code for every side, here TypeScript for both the Node server and the browser. If the server changes a field, the client stops compiling instead of breaking in production.

- **Field numbers, not names, are the wire identity** in the binary format. That's why renumbering a field is breaking and renaming is mostly safe. In **JSON**, though, the name *is* the identity, so renaming breaks JSON clients.
- **`buf`** is the modern toolchain: `buf lint` checks style rules (naming, request/response types per RPC, enum zero values), `buf generate` runs the code generators, and `buf breaking` compares the contract with an older version and refuses changes that would break existing clients.
- **Breaking-change categories** decide how strict that check is: `WIRE` (binary encoding only), `WIRE_JSON` (plus JSON), `PACKAGE`, and `FILE` (strictest: also generated code and services). This project uses `FILE`, because `WIRE_JSON` let an RPC be deleted (section 6).
- **Additive changes are safe:** a new field with a new number, a new RPC, a new enum value. Old clients ignore what they don't know.

## 2. ConnectRPC

Connect is an RPC framework from the makers of buf. One server handler speaks three protocols:

| Protocol | Who uses it | Notes |
|---|---|---|
| **Connect** | browsers, `curl`, any HTTP client | plain HTTP POST with JSON or binary; side-effect-free calls can be **GET** (cacheable) |
| **gRPC** | other services | needs HTTP/2 |
| **gRPC-Web** | browsers | no proxy needed with Connect's server |

- **Errors are codes**, the same set as gRPC: `NotFound`, `InvalidArgument`, `FailedPrecondition`, `Aborted`, `PermissionDenied`, `Unauthenticated`, `ResourceExhausted`... A client can branch on the code instead of parsing text.
- **Streaming:** a server-streaming RPC (`returns (stream X)`) works in browsers over `fetch` with a streaming response body. In Node, the handler is an `async function*`: every `yield` sends one message.
- **Interceptors** wrap every call; this app uses one to add the `Authorization` header.

## 3. TanStack Query in five minutes

TanStack Query (React Query) manages **server state**: data that lives on the server and is only cached in the browser.

- **Query keys** identify cached data. `connect-query` builds them from the RPC and its input, so `getIncident({id: 'INC-1001'})` is cached separately from `INC-1002`.
- **`staleTime`** says how long data counts as fresh; stale data is refetched on mount, on window focus, or when **invalidated**.
- **`useInfiniteQuery`** holds a list of pages and knows how to fetch the next one from the last page (`getNextPageParam`), which is exactly a page token.
- **`useMutation`** runs a change. Its lifecycle hooks are where optimistic updates live:
  - `onMutate`: cancel in-flight reads, save the current cache, write the expected result.
  - `onError`: put the saved cache back.
  - `onSettled`: invalidate, so the truth comes from the server.
- **`placeholderData: keepPreviousData`** keeps showing the old rows while a new filter loads, instead of flashing a spinner.

## 4. Two people, one incident: optimistic concurrency

The problem is the **lost update**: Asha and Ravi both load version 3; Asha saves; Ravi saves over her without seeing her change.

The fix used here:
1. Every incident has a `version` that goes up on each change.
2. Every write sends the version the client last saw (`expected_version`).
3. The server runs `UPDATE ... WHERE id = ? AND version = ?`. If zero rows changed, someone else got there first, and it returns `Aborted`.
4. The client shows a clear message and refetches; the person decides again with the current data.

It's called *optimistic* because nothing is locked while people look; conflicts are detected at write time. It fits when conflicts are rare and a retry is cheap. *Pessimistic* locking (check out an incident) fits when conflicts are common or a retry is expensive.

Two different refusals, two codes:
- **`FailedPrecondition`**: the action no longer makes sense in the current state (acknowledging an incident someone already acknowledged). Retrying won't help.
- **`Aborted`**: the action may still make sense, but you decided from old data. Reload and decide again.

## 5. Live updates without bugs

`WatchTimeline` sends the history, then live events. Things that go wrong in naive versions, and what this one does:

| Problem | What this project does |
|---|---|
| An event lands between "read history" and "subscribe" and is lost | subscribe **first**, then read history, and drop duplicates by id |
| The stream drops (network, deploy) | the client reconnects with backoff, 0.5 s doubling to 8 s |
| Reconnecting replays the history | the client merges by event id, so nothing shows twice |
| A client stays connected but stops reading | the server buffers at most 500 events, then ends that stream with `ResourceExhausted` |
| A closed tab leaves a subscriber behind | the handler's abort signal ends the loop; tested over real HTTP |
| How does the page know its copy is stale? | each event carries the incident version it produced; newer than the screen means refetch |

Why not compare timestamps? Clocks differ between machines, and two events can share a millisecond. A version number only goes up.

## 6. Pieces used here

| Piece | Where | Idea |
|---|---|---|
| `buf.yaml` breaking `FILE` | contract | strictest category, catches removed RPCs |
| `protoc-gen-es` `erasable_syntax=true` | `buf.gen.yaml` | generated code that Node can run by stripping types |
| `NO_SIDE_EFFECTS` + `useHttpGet` | proto, `web/session.ts` | reads go out as cacheable GETs |
| `connectNodeAdapter` | `server/app.ts` | Connect, gRPC-Web and static files on one port |
| `node:sqlite` | `server/store.ts` | SQLite built into Node, no dependency |
| keyset pagination | `server/store.ts` | `(opened_at, id) < cursor`: stable under inserts, fast at any depth |
| `createRouterTransport` | `test/server.test.ts` | the real client against handlers, in memory |
| `useInfiniteQuery` + `pageParamKey` | `web/App.tsx` | page tokens as TanStack Query pages |
| optimistic mutation with rollback | `web/App.tsx` | show it now, undo on refusal |
| `for await` over a server stream | `web/useTimeline.ts` | streaming in React with cleanup on unmount |
| Playwright `context.route` | `e2e/console.spec.ts` | cut one user's stream to force the conflict |

## 7. What broke while building

1. **`WIRE_JSON` allowed deleting an RPC.** The breaking-change test caught it; `FILE` refuses it.
2. **Generated `enum`s don't run in Node.** Node strips types, and an `enum` is runtime code (TS1294). `erasable_syntax=true` generates `as const` objects with the same values.
3. **The leak test failed on the in-memory transport.** That transport only runs the handler when the client pulls, so an abandoned stream stays paused. Over HTTP the cleanup works. The probe also showed the real gap, a connected client that stops reading, which led to the 500-event cap.
4. **Class names collided.** Timeline rows used the event kind as a class, and `note` and `status` were already the note form's and status badge's classes.
5. **Blocking a route doesn't cut an open stream.** Playwright's `route()` only sees new requests; the test reloads after blocking.

## 8. Explain it without notes

1. What does `buf breaking` check, and why `FILE` rather than `WIRE_JSON`?
2. Why is renaming a field breaking for JSON clients but not for binary ones?
3. Walk through what happens when Ravi resolves an incident Asha already changed: client, server, database, and back.
4. `FailedPrecondition` vs `Aborted`: which one when, and what should the client do with each?
5. Why keyset pagination instead of OFFSET? Why is the token opaque?
6. How does `WatchTimeline` avoid losing an event between history and live? Avoid showing one twice?
7. What happens to the server when a client stops reading but stays connected?
8. Optimistic update: what are `onMutate`, `onError` and `onSettled` each for here?
9. How does the page find out its incident changed, without polling it?
10. Why do reads go as GET, and what does that make possible?

## 9. Your turn

1. Add a `Reopen` RPC (resolved → triggered). Run `buf breaking` and watch it pass; then try removing a field and watch it fail.
2. Replace the demo tokens with real OIDC JWT verification in the interceptor, keeping the role check.
3. Stream list changes too: a `WatchIncidents` RPC that the list uses instead of polling every 15 s.
4. Run two server processes. What breaks? (The event bus is in memory, so a note on one server never reaches a watcher on the other.) Fix it with PostgreSQL `LISTEN/NOTIFY` or Redis pub/sub.
