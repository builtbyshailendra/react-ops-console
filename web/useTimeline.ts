// Subscribes to one incident's timeline over a server stream.
//
// - Reconnects with backoff when the stream drops; the server replays history
//   on every connect, so events are merged by id and nothing shows twice.
// - Calls onStale when an event says the incident moved past the version this
//   client is showing, so the detail view refetches instead of guessing.
// - Closes the stream on unmount or when the incident changes.

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@connectrpc/connect'
import { useTransport } from '@connectrpc/connect-query'
import { IncidentService, type TimelineEvent } from '../gen/ops/v1/incidents_pb.ts'

export type LiveState = 'connecting' | 'live' | 'reconnecting'

export function useTimeline(id: string, shownVersion: bigint | undefined, onStale: () => void) {
  const transport = useTransport()
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [state, setState] = useState<LiveState>('connecting')
  // Refs so a new version or callback doesn't tear down the stream.
  const version = useRef(shownVersion)
  const stale = useRef(onStale)
  version.current = shownVersion
  stale.current = onStale

  useEffect(() => {
    const client = createClient(IncidentService, transport)
    const ac = new AbortController()
    const seen = new Set<string>()
    setEvents([])
    setState('connecting')

    void (async () => {
      for (let attempt = 0; !ac.signal.aborted; attempt++) {
        try {
          for await (const { event } of client.watchTimeline({ id }, { signal: ac.signal })) {
            attempt = 0
            setState('live')
            if (!event || seen.has(event.id)) continue
            seen.add(event.id)
            setEvents((prev) => [...prev, event])
            if (version.current !== undefined && event.incidentVersion > version.current) stale.current()
          }
        } catch {
          if (ac.signal.aborted) return
        }
        // The stream ended or failed: wait, then reconnect (0.5 s, 1 s, 2 s, ... up to 8 s).
        setState('reconnecting')
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 8000)))
      }
    })()

    return () => ac.abort()
  }, [id, transport])

  return { events, state }
}
