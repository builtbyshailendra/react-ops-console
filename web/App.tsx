import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Code, ConnectError } from '@connectrpc/connect'
import {
  createConnectQueryKey, TransportProvider, useInfiniteQuery, useMutation, useQuery, useTransport,
} from '@connectrpc/connect-query'
import { keepPreviousData, QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { IncidentService, Severity, Status } from '../gen/ops/v1/incidents_pb.ts'
import { ago, clock, explain, sevLabel, STATUS_LABEL } from './format.ts'
import { DEMO_USERS, loadUser, makeTransport, saveUser, type DemoUser } from './session.ts'
import { useTimeline } from './useTimeline.ts'

export function App() {
  const [user, setUser] = useState(loadUser)
  if (!user) {
    return <SignIn onPick={(u) => { saveUser(u); setUser(u) }} />
  }
  // A new key gives each person a fresh transport and an empty cache.
  return <Session key={user.token} user={user} onSignOut={() => { saveUser(undefined); setUser(undefined) }} />
}

function SignIn({ onPick }: { onPick: (u: DemoUser) => void }) {
  return (
    <main className="signin">
      <h1>Ops console</h1>
      <p>Demo sign-in. Open a second tab as someone else to watch updates arrive live, or to see what happens when two people change the same incident.</p>
      <ul>
        {DEMO_USERS.map((u) => (
          <li key={u.token}>
            <button type="button" onClick={() => onPick(u)}>
              Continue as {u.name} <span className="role">{u.role}</span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}

const DONT_RETRY = new Set([Code.Unauthenticated, Code.PermissionDenied, Code.NotFound, Code.InvalidArgument])

function Session({ user, onSignOut }: { user: DemoUser; onSignOut: () => void }) {
  const transport = useMemo(() => makeTransport(user.token), [user.token])
  const queryClient = useMemo(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: (n, err) => n < 2 && !DONT_RETRY.has(ConnectError.from(err).code),
      },
    },
  }), [])
  return (
    <TransportProvider transport={transport}>
      <QueryClientProvider client={queryClient}>
        <Console user={user} onSignOut={onSignOut} />
      </QueryClientProvider>
    </TransportProvider>
  )
}

// The open incident lives in the URL hash, so a link can point at it.
function useSelected(): [string | undefined, (id: string) => void] {
  const read = () => decodeURIComponent(window.location.hash.slice(1)) || undefined
  const [id, setId] = useState(read)
  useEffect(() => {
    const onHash = () => setId(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return [id, (next) => { window.location.hash = encodeURIComponent(next) }]
}

function Console({ user, onSignOut }: { user: DemoUser; onSignOut: () => void }) {
  const [selected, select] = useSelected()
  return (
    <div className="shell">
      <header className="top">
        <h1>Ops console</h1>
        <div className="who">
          Signed in as <strong>{user.name}</strong> <span className="role">{user.role}</span>
          <button type="button" className="link" onClick={onSignOut}>Switch user</button>
        </div>
      </header>
      <div className="panes">
        <IncidentList selected={selected} onSelect={select} />
        <main className="detail-pane">
          {selected ? <IncidentDetail key={selected} id={selected} user={user} /> : <p className="empty">Pick an incident from the list.</p>}
        </main>
      </div>
    </div>
  )
}

const ALL_STATUSES = [Status.TRIGGERED, Status.ACKNOWLEDGED, Status.MITIGATED, Status.RESOLVED]

function IncidentList({ selected, onSelect }: { selected?: string; onSelect: (id: string) => void }) {
  const [statuses, setStatuses] = useState<Status[]>([Status.TRIGGERED, Status.ACKNOWLEDGED, Status.MITIGATED])
  const [atLeast, setAtLeast] = useState<Severity>(Severity.UNSPECIFIED) // UNSPECIFIED = any
  const list = useInfiniteQuery(
    IncidentService.method.listIncidents,
    { statuses, atLeast, pageSize: 15, pageToken: '' },
    {
      pageParamKey: 'pageToken',
      getNextPageParam: (last) => last.nextPageToken || undefined,
      // The open incident streams; the list is polled, which is plenty for a list.
      refetchInterval: 15_000,
      placeholderData: keepPreviousData, // keep showing rows while a new filter loads
    },
  )
  const incidents = list.data?.pages.flatMap((p) => p.incidents) ?? []

  const toggle = (s: Status) =>
    setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : ALL_STATUSES.filter((x) => x === s || cur.includes(x))))

  return (
    <nav className="list-pane" aria-label="Incidents">
      <fieldset className="filters">
        <legend>Filter</legend>
        <div className="checks">
          {ALL_STATUSES.map((s) => (
            <label key={s}>
              <input type="checkbox" checked={statuses.includes(s)} onChange={() => toggle(s)}
                disabled={statuses.length === 1 && statuses.includes(s)} />
              {STATUS_LABEL[s]}
            </label>
          ))}
        </div>
        <label className="sev-filter">
          Severity
          <select value={atLeast} onChange={(e) => setAtLeast(Number(e.target.value) as Severity)}>
            <option value={0}>Any</option>
            <option value={1}>SEV1 only</option>
            <option value={2}>SEV2 or worse</option>
            <option value={3}>SEV3 or worse</option>
          </select>
        </label>
      </fieldset>

      {list.isPending ? <p className="muted">Loading incidents...</p> : list.isError ? (
        <p role="alert" className="problem">{explain(list.error)}</p>
      ) : (
        <>
          <p className="muted count" aria-live="polite">
            {incidents.length} shown{list.hasNextPage ? ', more available' : ''}{list.isFetching && !list.isFetchingNextPage ? ' (refreshing)' : ''}
          </p>
          <ul className="rows">
            {incidents.map((inc) => (
              <li key={inc.id}>
                <button type="button" className="row" aria-current={inc.id === selected ? 'true' : undefined} onClick={() => onSelect(inc.id)}>
                  <span className={`sev sev${inc.severity}`}>{sevLabel(inc.severity)}</span>
                  <span className="row-main">
                    <span className="row-title">{inc.title}</span>
                    <span className="row-meta">{inc.id} · {ago(inc.openedAt)}{inc.owner ? ` · ${inc.owner}` : ''}</span>
                  </span>
                  <span className={`status st${inc.status}`}>{STATUS_LABEL[inc.status]}</span>
                </button>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <button type="button" className="more" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? 'Loading...' : 'Load more'}
            </button>
          )}
        </>
      )}
    </nav>
  )
}

function IncidentDetail({ id, user }: { id: string; user: DemoUser }) {
  const transport = useTransport()
  const qc = useQueryClient()
  const [problem, setProblem] = useState<string>()
  const [text, setText] = useState('')

  const detail = useQuery(IncidentService.method.getIncident, { id })
  const inc = detail.data?.incident
  const detailKey = createConnectQueryKey({ schema: IncidentService.method.getIncident, input: { id }, transport, cardinality: 'finite' })
  const refresh = () => qc.invalidateQueries({ queryKey: createConnectQueryKey({ schema: IncidentService, cardinality: undefined }) })
  const { events, state } = useTimeline(id, inc?.version, refresh)

  // Show the new status at once; put the old one back if the server says no.
  async function showStatus(status: Status, owner?: string) {
    setProblem(undefined)
    await qc.cancelQueries({ queryKey: detailKey })
    const before = qc.getQueryData(detailKey)
    qc.setQueryData(detailKey, (prev) =>
      prev?.incident ? { ...prev, incident: { ...prev.incident, status, owner: owner ?? prev.incident.owner } } : prev)
    return { before }
  }

  const acknowledge = useMutation(IncidentService.method.acknowledge, {
    onMutate: () => showStatus(Status.ACKNOWLEDGED, user.name),
    onError: (err, _vars, ctx) => { if (ctx?.before) qc.setQueryData(detailKey, ctx.before); setProblem(explain(err)) },
    onSettled: refresh,
  })
  const move = useMutation(IncidentService.method.updateStatus, {
    onMutate: (vars) => showStatus(vars.status ?? Status.UNSPECIFIED),
    onError: (err, _vars, ctx) => { if (ctx?.before) qc.setQueryData(detailKey, ctx.before); setProblem(explain(err)) },
    onSettled: refresh,
  })
  const note = useMutation(IncidentService.method.addNote, {
    onMutate: () => setProblem(undefined),
    onError: (err) => setProblem(explain(err)),
    onSuccess: () => setText(''),
  })

  if (detail.isPending) return <p className="muted">Loading {id}...</p>
  if (detail.isError || !inc) return <p role="alert" className="problem">{detail.isError ? explain(detail.error) : `${id} not found.`}</p>

  const busy = acknowledge.isPending || move.isPending || detail.isFetching
  const submitNote = (e: FormEvent) => {
    e.preventDefault()
    if (text.trim()) note.mutate({ id, text })
  }

  return (
    <article className="detail" aria-labelledby="detail-title">
      <header>
        <p className="detail-id">
          {inc.id} <span className={`sev sev${inc.severity}`}>{sevLabel(inc.severity)}</span>{' '}
          <span className={`status st${inc.status}`} data-testid="status">{STATUS_LABEL[inc.status]}</span>
        </p>
        <h2 id="detail-title">{inc.title}</h2>
        <dl className="facts">
          <div><dt>Service</dt><dd>{inc.service}</dd></div>
          <div><dt>Owner</dt><dd data-testid="owner">{inc.owner || 'nobody yet'}</dd></div>
          <div><dt>Opened</dt><dd>{ago(inc.openedAt)}</dd></div>
          <div><dt>Version</dt><dd data-testid="version">{String(inc.version)}</dd></div>
        </dl>
      </header>

      {problem && <p role="alert" className="problem">{problem}</p>}

      {user.role === 'viewer' ? (
        <p className="muted">You are signed in as a viewer: read only.</p>
      ) : (
        <>
          <div className="actions">
            {inc.status === Status.TRIGGERED && (
              <button type="button" className="primary" disabled={busy}
                onClick={() => acknowledge.mutate({ id, expectedVersion: inc.version })}>Acknowledge</button>
            )}
            {inc.status === Status.ACKNOWLEDGED && (
              <button type="button" disabled={busy}
                onClick={() => move.mutate({ id, status: Status.MITIGATED, expectedVersion: inc.version })}>Mark mitigated</button>
            )}
            {(inc.status === Status.ACKNOWLEDGED || inc.status === Status.MITIGATED) && (
              <button type="button" className="primary" disabled={busy}
                onClick={() => move.mutate({ id, status: Status.RESOLVED, expectedVersion: inc.version })}>Resolve</button>
            )}
          </div>
          <form className="note" onSubmit={submitNote}>
            <label htmlFor="note-text">Add a note</label>
            <textarea id="note-text" rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="What did you check or change?" />
            <button type="submit" disabled={note.isPending || !text.trim()}>{note.isPending ? 'Posting...' : 'Post note'}</button>
          </form>
        </>
      )}

      <section className="timeline-box" aria-labelledby="timeline-title">
        <h3 id="timeline-title">
          Timeline <span className={`live ${state}`} data-testid="live">{state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting...' : 'Reconnecting...'}</span>
        </h3>
        <ol className="timeline" aria-live="polite" aria-relevant="additions">
          {events.map((e) => (
            <li key={e.id} className={`ev ev-${e.kind}`}>
              <time>{clock(e.at)}</time>
              <span className="ev-who">{e.author}</span>
              <span className="ev-text">{e.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  )
}
