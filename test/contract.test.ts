// The contract's guarantees, tested: it lints, and buf refuses changes that
// would break existing clients while allowing additive ones. In CI this is
// what stops a pull request from renaming a field the mobile app still reads.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const PROTO = 'proto/ops/v1/incidents.proto'
const original = fs.readFileSync(path.join(root, PROTO), 'utf8')

function buf(args: string[], cwd = root): { code: number; out: string } {
  const r = spawnSync('npx', ['buf', ...args], { cwd, shell: true, encoding: 'utf8' })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// A copy of the module with the proto changed by `edit`.
function variant(edit: (src: string) => string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-'))
  fs.mkdirSync(path.join(dir, 'proto/ops/v1'), { recursive: true })
  fs.copyFileSync(path.join(root, 'buf.yaml'), path.join(dir, 'buf.yaml'))
  const changed = edit(original)
  assert.notEqual(changed, original, 'the edit did not change anything')
  fs.writeFileSync(path.join(dir, PROTO), changed)
  return dir
}

function breaking(dir: string): { code: number; out: string } {
  return buf(['breaking', JSON.stringify(dir), '--against', JSON.stringify(root)])
}

test('the contract passes buf lint', () => {
  const r = buf(['lint'])
  assert.equal(r.code, 0, r.out)
})

const breakingEdits: [string, (s: string) => string, RegExp][] = [
  ['rename a field (JSON clients send "owner")', (s) => s.replace('string owner = 6;', 'string assignee = 6;'), /name|json/i],
  ['change a field type', (s) => s.replace('int64 version = 9;', 'string version = 9;'), /type/i],
  ['delete a field', (s) => s.replace(/\n  string service = 5;/, ''), /delete/i],
  ['renumber a field', (s) => s.replace('string title = 2;', 'string title = 12;'), /delete|number|"title"/i],
  ['rename an enum value', (s) => s.replaceAll('STATUS_MITIGATED', 'STATUS_CONTAINED'), /enum value|MITIGATED/i],
  ['remove an RPC', (s) => s.replace(/\n  rpc AddNote\(AddNoteRequest\) returns \(AddNoteResponse\);/, ''), /AddNote|rpc/i],
]

for (const [name, edit, why] of breakingEdits) {
  test(`buf refuses a breaking change: ${name}`, () => {
    const r = breaking(variant(edit))
    assert.notEqual(r.code, 0, `buf breaking should have failed:\n${r.out}`)
    assert.match(r.out, why)
  })
}

test('buf allows additive changes: a new field and a new RPC', () => {
  const dir = variant((s) => s
    .replace('int64 version = 9;\n}', 'int64 version = 9;\n  string runbook_url = 10;\n}')
    .replace('rpc WatchTimeline(', 'rpc Reopen(ReopenRequest) returns (ReopenResponse);\n  rpc WatchTimeline(')
    + '\nmessage ReopenRequest {\n  string id = 1;\n}\n\nmessage ReopenResponse {\n  Incident incident = 1;\n}\n')
  const r = breaking(dir)
  assert.equal(r.code, 0, r.out)
})
