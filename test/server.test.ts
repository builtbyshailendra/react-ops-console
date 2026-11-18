// The server's rules, tested through a real Connect client. Most tests use an
// in-memory transport (no sockets, same code path as the network); the last
// ones start the HTTP server to prove streaming and static files work for real.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Code, ConnectError, createClient, createRouterTransport, type Client } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { IncidentService, Status, type Incident } from '../gen/ops/v1/incidents_pb.ts'
import { MAX_PENDING, routes } from '../server/service.ts'
import { Store } from '../server/store.ts'
import { startApp } from '../server/app.ts'

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })
const ASHA = as('demo-asha')
const RAVI = as('demo-ravi')
const VIEWER = as('demo-viewer')

function setup(): { store: Store; client: Client<typeof IncidentService> } {
  const store = new Store()
  store.seed()
  return { store, client: createClient(IncidentService, createRouterTransport(routes(store))) }
}

async function rejects(p: Promise<unknown>, code: Code, message?: RegExp): Promise<ConnectError> {
  try {
    await p
  } catch (err) {
    const ce = ConnectError.from(err)
    assert.equal(Code[ce.code], Code[code], ce.message)
    if (message) assert.match(ce.rawMessage, message)
    return ce
  }
  assert.fail(`expected ${Code[code]}, but the call succeeded`)
}

async function firstWith(client: Client<typeof IncidentService>, status: Status): Promise<Incident> {
  const { incidents } = await client.listIncidents({ statuses: [status], pageSize: 1 }, ASHA)
  assert.equal(incidents.length, 1, `seed data has no incident with status ${status}`)
  return incidents[0]
}

test('no token is Unauthenticated; a viewer can read but not change', async () => {
  const { client } = setup()
  await rejects(client.listIncidents({}), Code.Unauthenticated)
  await rejects(client.listIncidents({}, as('demo-nobody')), Code.Unauthenticated)
  const { incidents } = await client.listIncidents({ pageSize: 1 }, VIEWER)
  assert.equal(incidents.length, 1)
  await rejects(client.addNote({ id: incidents[0].id, text: 'hi' }, VIEWER), Code.PermissionDenied, /view/)
})

test('pages walk every incident once, newest first, with an opaque token', async () => {
  const { client } = setup()
  const seen: Incident[] = []
  let token = ''
  let pages = 0
  do {
    const r = await client.listIncidents({ pageSize: 7, pageToken: token }, ASHA)
    seen.push(...r.incidents)
    token = r.nextPageToken
    pages++
  } while (token)
  assert.equal(seen.length, 60)
  assert.equal(pages, 9) // 8 full pages of 7 + one of 4
  assert.equal(new Set(seen.map((i) => i.id)).size, 60, 'an incident appeared twice')
  const opened = seen.map((i) => Number(i.openedAt!.seconds))
  assert.deepEqual(opened, [...opened].sort((a, b) => b - a))
  await rejects(client.listIncidents({ pageToken: 'not-a-token' }, ASHA), Code.InvalidArgument, /page_token/)
  await rejects(client.listIncidents({ pageSize: 101 }, ASHA), Code.InvalidArgument, /page_size/)
})

test('filters: by status and by "at least this severe"', async () => {
  const { client } = setup()
  const open = await client.listIncidents({ statuses: [Status.TRIGGERED, Status.ACKNOWLEDGED], pageSize: 100 }, ASHA)
  assert.ok(open.incidents.length > 0)
  assert.ok(open.incidents.every((i) => i.status === Status.TRIGGERED || i.status === Status.ACKNOWLEDGED))
  const severe = await client.listIncidents({ atLeast: 2, pageSize: 100 }, ASHA)
  assert.ok(severe.incidents.length > 0)
  assert.ok(severe.incidents.every((i) => i.severity <= 2), 'SEV3/SEV4 leaked into an "at least SEV2" filter')
})

test('acknowledge takes the incident once; a second acknowledge is FailedPrecondition', async () => {
  const { client } = setup()
  const inc = await firstWith(client, Status.TRIGGERED)
  const { incident } = await client.acknowledge({ id: inc.id, expectedVersion: inc.version }, ASHA)
  assert.equal(incident!.status, Status.ACKNOWLEDGED)
  assert.equal(incident!.owner, 'asha')
  assert.equal(incident!.version, inc.version + 1n)
  await rejects(client.acknowledge({ id: inc.id, expectedVersion: incident!.version }, RAVI), Code.FailedPrecondition, /already acknowledged by asha/)
})

test('two responders, one version: the second write is Aborted, not silently lost', async () => {
  const { client } = setup()
  const inc = await firstWith(client, Status.ACKNOWLEDGED)
  // Both loaded the same version. Asha marks it mitigated first.
  await client.updateStatus({ id: inc.id, status: Status.MITIGATED, expectedVersion: inc.version }, ASHA)
  // Ravi, still looking at the old version, tries to resolve it.
  const err = await rejects(
    client.updateStatus({ id: inc.id, status: Status.RESOLVED, expectedVersion: inc.version }, RAVI),
    Code.Aborted, /someone else changed it/)
  assert.match(err.rawMessage, new RegExp(`version ${inc.version + 1n}, not ${inc.version}`))
  // After reloading, Ravi's change goes through.
  const fresh = (await client.getIncident({ id: inc.id }, RAVI)).incident!
  const { incident } = await client.updateStatus({ id: inc.id, status: Status.RESOLVED, expectedVersion: fresh.version }, RAVI)
  assert.equal(incident!.status, Status.RESOLVED)
})

test('status only moves forward', async () => {
  const { client } = setup()
  const inc = await firstWith(client, Status.RESOLVED)
  await rejects(client.updateStatus({ id: inc.id, status: Status.MITIGATED, expectedVersion: inc.version }, ASHA), Code.FailedPrecondition, /resolved to mitigated/)
  await rejects(client.updateStatus({ id: inc.id, status: Status.ACKNOWLEDGED, expectedVersion: inc.version }, ASHA), Code.InvalidArgument, /Acknowledge/)
  await rejects(client.updateStatus({ id: inc.id, status: 99 as Status, expectedVersion: inc.version }, ASHA), Code.FailedPrecondition)
})

test('notes are validated; unknown incidents are NotFound', async () => {
  const { client } = setup()
  const inc = await firstWith(client, Status.TRIGGERED)
  await rejects(client.addNote({ id: inc.id, text: '   ' }, ASHA), Code.InvalidArgument)
  await rejects(client.addNote({ id: inc.id, text: 'x'.repeat(2001) }, ASHA), Code.InvalidArgument)
  const { event } = await client.addNote({ id: inc.id, text: '  rolled back deploy 4812  ' }, ASHA)
  assert.equal(event!.text, 'rolled back deploy 4812')
  assert.equal(event!.author, 'asha')
  await rejects(client.getIncident({ id: 'INC-0' }, ASHA), Code.NotFound)
  await rejects(client.addNote({ id: 'INC-0', text: 'hi' }, ASHA), Code.NotFound)
})

test('WatchTimeline sends history, then live events in order', async () => {
  const { client } = setup()
  const inc = await firstWith(client, Status.TRIGGERED)
  const ac = new AbortController()
  const stream = client.watchTimeline({ id: inc.id }, { ...VIEWER, signal: ac.signal })[Symbol.asyncIterator]()

  const history = await stream.next()
  assert.equal(history.value.event.kind, 'opened')

  await client.acknowledge({ id: inc.id, expectedVersion: inc.version }, ASHA)
  await client.addNote({ id: inc.id, text: 'checking the deploy' }, RAVI)
  assert.equal((await stream.next()).value.event.kind, 'acknowledged')
  const note = (await stream.next()).value.event
  assert.equal(note.kind, 'note')
  assert.equal(note.author, 'ravi')
  ac.abort()
  // Whether the server notices the client left is checked over real HTTP
  // below: this in-memory transport only runs the handler when the client
  // pulls, so an abandoned handler just stays paused.
})

test('a subscriber that stops reading is dropped, not buffered forever', async () => {
  const { store, client } = setup()
  const inc = await firstWith(client, Status.TRIGGERED)
  const stream = client.watchTimeline({ id: inc.id }, VIEWER)[Symbol.asyncIterator]()
  await stream.next() // history; then the client stops reading
  for (let i = 0; i <= MAX_PENDING; i++) store.addEvent(inc.id, 'loadgen', 'note', `event ${i}`)
  assert.equal(store.events.listenerCount(inc.id), 0, 'the stuck subscriber is still attached')
  await rejects(stream.next(), Code.ResourceExhausted, /reconnect/)
})

test('over real HTTP: a note streams to another client, and leaving unsubscribes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'))
  const app = await startApp({ dbPath: path.join(dir, 'ops.db') })
  try {
    const client = createClient(IncidentService, createConnectTransport({ baseUrl: app.url, httpVersion: '1.1' }))
    const inc = await firstWith(client, Status.TRIGGERED)
    const ac = new AbortController()
    const stream = client.watchTimeline({ id: inc.id }, { ...VIEWER, signal: ac.signal })[Symbol.asyncIterator]()
    assert.equal((await stream.next()).value.event.kind, 'opened')
    assert.equal(app.store.events.listenerCount(inc.id), 1)
    await client.addNote({ id: inc.id, text: 'over the wire' }, ASHA)
    assert.equal((await stream.next()).value.event.text, 'over the wire')

    ac.abort()
    await assert.rejects(stream.next()) // the client sees Canceled
    for (let i = 0; i < 100 && app.store.events.listenerCount(inc.id) > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(app.store.events.listenerCount(inc.id), 0, 'the server kept a subscriber after the client left')
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('over real HTTP: the React app is served, and paths cannot escape its folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-static-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>console</title>')
  fs.writeFileSync(path.join(path.dirname(dir), 'ops-secret.txt'), 'secret')
  const app = await startApp({ staticDir: dir })
  try {
    const home = await fetch(`${app.url}/`)
    assert.equal(home.status, 200)
    assert.match(home.headers.get('content-type') ?? '', /text\/html/)
    // A deep link in a single-page app gets index.html.
    assert.match(await (await fetch(`${app.url}/incidents/INC-1001`)).text(), /console/)
    // Encoded ../ is normalised away, so it can't reach a sibling file.
    const escape = await (await fetch(`${app.url}/..%2fops-secret.txt`)).text()
    assert.doesNotMatch(escape, /secret/)
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(path.join(path.dirname(dir), 'ops-secret.txt'), { force: true })
  }
})
