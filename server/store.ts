// Incidents and their timelines in Node's built-in SQLite.

import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

export interface IncidentRow {
  id: string
  title: string
  severity: number
  status: number
  service: string
  owner: string
  opened_at: number
  updated_at: number
  version: number
}

export interface EventRow {
  id: string
  incident_id: string
  author: string
  kind: string
  text: string
  at: number
}

export class StaleVersionError extends Error {}
export class NotFoundError extends Error {}

export class Store {
  readonly db: DatabaseSync
  // Timeline events are published here after they're stored; WatchTimeline
  // subscribers listen per incident.
  readonly events = new EventEmitter().setMaxListeners(0)

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, severity INTEGER NOT NULL, status INTEGER NOT NULL,
        service TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS incidents_newest ON incidents (opened_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS timeline (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, incident_id TEXT NOT NULL,
        author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS timeline_incident ON timeline (incident_id, seq);
    `)
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM incidents').get() as { n: number }).n)
  }

  // Deterministic demo data: the same incidents every time for a given seed.
  seed(n = 60, seed = 7, now = Date.now()): void {
    if (this.count() > 0) return
    let x = seed
    const rand = (): number => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const services = ['payments-api', 'checkout-web', 'ledger-worker', 'search-api', 'auth-service']
    const problems = ['error rate above 5%', 'p99 latency over 2 s', 'queue backlog growing', 'pods crash-looping',
      'certificate expires in 3 days', 'replica lag over 60 s']
    const insert = this.db.prepare(`INSERT INTO incidents (id, title, severity, status, service, owner, opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (let i = 1; i <= n; i++) {
      const service = services[Math.floor(rand() * services.length)]
      const sev = 1 + Math.floor(rand() ** 0.7 * 4)
      const status = 1 + Math.floor(rand() ** 1.5 * 4)
      const opened = now - Math.floor(rand() * 3 * 24 * 3600_000)
      const id = `INC-${String(1000 + i)}`
      const owner = status >= 2 ? ['asha', 'ravi', 'meera'][i % 3] : ''
      insert.run(id, `${service}: ${problems[Math.floor(rand() * problems.length)]}`, sev, status, service, owner, opened, opened)
      this.addEvent(id, 'monitoring', 'opened', `Alert fired for ${service}`, opened, false)
    }
  }

  get(id: string): IncidentRow {
    const row = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRow | undefined
    if (!row) throw new NotFoundError(`incident ${id} not found`)
    return row
  }

  // Keyset pagination, newest first. The cursor is the last row's
  // (opened_at, id); the client only ever sees it as an opaque token.
  list(statuses: number[], atLeast: number, pageSize: number, after?: { o: number; i: string }): IncidentRow[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`)
      args.push(...statuses)
    }
    if (atLeast > 0) {
      where.push('severity <= ?') // SEV1 is the most severe
      args.push(atLeast)
    }
    if (after) {
      where.push('(opened_at < ? OR (opened_at = ? AND id < ?))')
      args.push(after.o, after.o, after.i)
    }
    const sql = `SELECT * FROM incidents ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY opened_at DESC, id DESC LIMIT ?`
    return this.db.prepare(sql).all(...args, pageSize) as unknown as IncidentRow[]
  }

  // Change an incident only if nobody else changed it since `expectedVersion`.
  update(id: string, expectedVersion: number, changes: { status?: number; owner?: string }, now = Date.now()): IncidentRow {
    const sets = ['version = version + 1', 'updated_at = ?']
    const args: (string | number)[] = [now]
    if (changes.status !== undefined) { sets.push('status = ?'); args.push(changes.status) }
    if (changes.owner !== undefined) { sets.push('owner = ?'); args.push(changes.owner) }
    const r = this.db.prepare(`UPDATE incidents SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
      .run(...args, id, expectedVersion)
    if (Number(r.changes) === 0) {
      const current = this.get(id) // throws NotFoundError if it doesn't exist
      throw new StaleVersionError(`incident ${id} is at version ${current.version}, not ${expectedVersion}`)
    }
    return this.get(id)
  }

  addEvent(incidentId: string, author: string, kind: string, text: string, at = Date.now(), publish = true): EventRow {
    const ev: EventRow = { id: randomUUID(), incident_id: incidentId, author, kind, text, at }
    this.db.prepare('INSERT INTO timeline (id, incident_id, author, kind, text, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ev.id, ev.incident_id, ev.author, ev.kind, ev.text, ev.at)
    if (publish) this.events.emit(incidentId, ev)
    return ev
  }

  timeline(incidentId: string): EventRow[] {
    return this.db.prepare('SELECT id, incident_id, author, kind, text, at FROM timeline WHERE incident_id = ? ORDER BY seq')
      .all(incidentId) as unknown as EventRow[]
  }

  close(): void {
    this.db.close()
  }
}
