// The IncidentService implementation: Connect handlers over the store.
// Errors use Connect codes, which every client (browser, Go, curl) can act on:
// Unauthenticated, PermissionDenied, NotFound, InvalidArgument,
// FailedPrecondition (an impossible status change), Aborted (a stale version).

import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect'
import { create } from '@bufbuild/protobuf'
import { timestampFromMs } from '@bufbuild/protobuf/wkt'
import {
  IncidentSchema, IncidentService, Status, TimelineEventSchema,
  type Incident, type Severity, type TimelineEvent,
} from '../gen/ops/v1/incidents_pb.ts'
import { NotFoundError, StaleVersionError, type EventRow, type IncidentRow, type Store } from './store.ts'

// Demo identities. A real deployment would verify OIDC tokens instead.
export const USERS: Record<string, { name: string; role: 'responder' | 'viewer' }> = {
  'demo-asha': { name: 'asha', role: 'responder' },
  'demo-ravi': { name: 'ravi', role: 'responder' },
  'demo-viewer': { name: 'guest', role: 'viewer' },
}

function caller(ctx: HandlerContext, needs: 'responder' | 'viewer' = 'viewer'): { name: string } {
  const token = (ctx.requestHeader.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const user = USERS[token]
  if (!user) throw new ConnectError('sign in first', Code.Unauthenticated)
  if (needs === 'responder' && user.role !== 'responder') {
    throw new ConnectError(`${user.name} can view incidents but not change them`, Code.PermissionDenied)
  }
  return user
}

const toIncident = (r: IncidentRow): Incident => create(IncidentSchema, {
  id: r.id, title: r.title, severity: r.severity as Severity, status: r.status as Status, service: r.service,
  owner: r.owner, openedAt: timestampFromMs(r.opened_at), updatedAt: timestampFromMs(r.updated_at),
  version: BigInt(r.version),
})

const toEvent = (e: EventRow): TimelineEvent => create(TimelineEventSchema, {
  id: e.id, incidentId: e.incident_id, author: e.author, kind: e.kind, text: e.text, at: timestampFromMs(e.at),
})

// Live timeline events buffered per subscriber before it counts as stuck.
export const MAX_PENDING = 500

const STATUS_NAME: Record<number, string> = {
  [Status.TRIGGERED]: 'triggered', [Status.ACKNOWLEDGED]: 'acknowledged',
  [Status.MITIGATED]: 'mitigated', [Status.RESOLVED]: 'resolved',
}

// Store errors become Connect errors.
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof NotFoundError) throw new ConnectError(err.message, Code.NotFound)
    if (err instanceof StaleVersionError) throw new ConnectError(`${err.message}: someone else changed it; reload and try again`, Code.Aborted)
    throw err
  }
}

function encodeToken(r: IncidentRow): string {
  return Buffer.from(JSON.stringify({ o: r.opened_at, i: r.id })).toString('base64url')
}

function decodeToken(token: string): { o: number; i: string } {
  try {
    const v = JSON.parse(Buffer.from(token, 'base64url').toString())
    if (typeof v.o === 'number' && typeof v.i === 'string') return v
  } catch { /* fall through */ }
  throw new ConnectError('page_token is not one this server issued', Code.InvalidArgument)
}

export function routes(store: Store) {
  return (router: ConnectRouter) => router.service(IncidentService, {
    listIncidents(req, ctx) {
      caller(ctx)
      const size = req.pageSize === 0 ? 20 : req.pageSize
      if (size < 1 || size > 100) throw new ConnectError('page_size must be 1-100', Code.InvalidArgument)
      // Fetch one extra row to know whether there is a next page.
      const rows = store.list(req.statuses, req.atLeast, size + 1, req.pageToken ? decodeToken(req.pageToken) : undefined)
      const page = rows.slice(0, size)
      return { incidents: page.map(toIncident), nextPageToken: rows.length > size ? encodeToken(page[page.length - 1]) : '' }
    },

    getIncident(req, ctx) {
      caller(ctx)
      return { incident: toIncident(guard(() => store.get(req.id))) }
    },

    acknowledge(req, ctx) {
      const user = caller(ctx, 'responder')
      const current = guard(() => store.get(req.id))
      if (current.status !== Status.TRIGGERED) {
        throw new ConnectError(`already ${STATUS_NAME[current.status]} by ${current.owner || 'someone'}`, Code.FailedPrecondition)
      }
      const updated = guard(() => store.update(req.id, Number(req.expectedVersion), { status: Status.ACKNOWLEDGED, owner: user.name }))
      store.addEvent(req.id, user.name, 'acknowledged', `${user.name} is on it`)
      return { incident: toIncident(updated) }
    },

    updateStatus(req, ctx) {
      const user = caller(ctx, 'responder')
      const current = guard(() => store.get(req.id))
      if (req.status === Status.ACKNOWLEDGED) {
        throw new ConnectError('use Acknowledge to take an incident', Code.InvalidArgument)
      }
      if (!(req.status in STATUS_NAME) || req.status <= current.status) {
        throw new ConnectError(`can't move from ${STATUS_NAME[current.status]} to ${STATUS_NAME[req.status] ?? 'that'}`, Code.FailedPrecondition)
      }
      const updated = guard(() => store.update(req.id, Number(req.expectedVersion), { status: req.status }))
      store.addEvent(req.id, user.name, 'status', `${user.name} marked it ${STATUS_NAME[req.status]}`)
      return { incident: toIncident(updated) }
    },

    addNote(req, ctx) {
      const user = caller(ctx, 'responder')
      const text = req.text.trim()
      if (!text || text.length > 2000) throw new ConnectError('a note needs 1-2000 characters', Code.InvalidArgument)
      guard(() => store.get(req.id))
      return { event: toEvent(store.addEvent(req.id, user.name, 'note', text)) }
    },

    // History first, then live events. Subscribing *before* reading the
    // history means an event added in between is buffered, not lost; the
    // id check drops the one that would otherwise arrive twice.
    //
    // A client that stays connected but stops reading would make `pending`
    // grow forever, so the buffer is capped: past MAX_PENDING the server
    // unsubscribes and ends the stream with ResourceExhausted. The client
    // reconnects and gets the full history again, so nothing is lost.
    async *watchTimeline(req, ctx) {
      caller(ctx)
      guard(() => store.get(req.id))
      const pending: EventRow[] = []
      let overflowed = false
      let wake: (() => void) | undefined
      const onEvent = (e: EventRow): void => {
        if (pending.length >= MAX_PENDING) {
          overflowed = true
          store.events.off(req.id, onEvent)
        } else {
          pending.push(e)
        }
        wake?.()
      }
      store.events.on(req.id, onEvent)
      try {
        const seen = new Set<string>()
        for (const e of store.timeline(req.id)) {
          seen.add(e.id)
          yield { event: toEvent(e) }
        }
        while (!ctx.signal.aborted) {
          if (overflowed) throw new ConnectError('timeline client fell too far behind; reconnect', Code.ResourceExhausted)
          while (pending.length) {
            const e = pending.shift()!
            if (!seen.has(e.id)) {
              seen.add(e.id)
              yield { event: toEvent(e) }
            }
          }
          await new Promise<void>((resolve) => {
            wake = resolve
            ctx.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          wake = undefined
        }
      } finally {
        store.events.off(req.id, onEvent)
      }
    },
  })
}
