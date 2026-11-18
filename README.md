# react-ops-console

An incident console built contract-first: a Protobuf API checked by `buf`, a Node server speaking ConnectRPC with SQLite storage, and a React 19 front end using TanStack Query. Live timeline updates stream from the server, and two people editing the same incident can't silently overwrite each other.

Status: built step by step, locally. Not published.

## Build log

### Step 1: the contract

`proto/ops/v1/incidents.proto` is the single source of truth: incidents, timeline events, and an `IncidentService` with list (filters, page tokens), get, acknowledge, update status, add note, and a server-streaming `WatchTimeline`. Reads are marked `NO_SIDE_EFFECTS` so Connect can send them as cacheable GETs. Updates carry the `version` the client read; a stale version will be refused.

`buf generate` (buf 1.75 with protoc-gen-es 2.17) writes TypeScript used by both the server and the browser; `buf lint` checks the standard style rules.

`test/contract.test.ts` makes six breaking edits and two additive ones to a copy of the contract and checks what `buf breaking` says: renaming a field, changing a type, deleting a field, renumbering, renaming an enum value and removing an RPC are refused; a new field and a new RPC are allowed.

What broke: I first set the breaking-change category to `WIRE_JSON`. The test showed it **allowed removing an RPC**: wire categories only judge how messages are encoded, and an RPC isn't a message. A client calling it would fail at runtime. Switched to `FILE`, the strictest category, which also covers generated code and services.

Note: npm held back `@bufbuild/buf`'s install script for review; buf works without it, so it stays unapproved.
