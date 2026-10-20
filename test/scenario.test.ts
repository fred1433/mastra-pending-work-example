import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Runs the two-process scenario into a temporary folder, so the committed trace is left alone. */
function runScenario(tz?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-'))
  const env = { ...process.env, TRACE_DIR: dir, ...(tz ? { TZ: tz } : {}) }
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scenario', 'run.ts')], { cwd: root, env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(fs.readFileSync(path.join(dir, 'scenario-trace.json'), 'utf8'))
}

let baseline: any
const base = () => (baseline ??= runScenario())

test('scenario: two threads, one decision, a booking change, a redraft, a restart, one email', () => {
  const t = base()
  const steps: string[] = t.steps.map((s: any) => s.step)
  const order = ['Email in A', 'Email in B', 'Internal note', 'Manager authorisation recorded', 'Proposal W1-r1 drafted', 'Suspended for approval of W1-r1',
    'Booking edited in the CRM', 'Proposal invalidated at once', 'Approval refused', 'Wake-up pushed back, edits grouped', 'Proposal W1-r2 drafted',
    'Process 1 exits', 'Process 2 started', 'Suspended run found in Postgres', 'W1-r2 approved', 'Second click: existing approval returned',
    'Approval consumed', 'Intent to send recorded (same transaction)', 'Email accepted by the provider']
  let i = -1
  for (const s of order) { const j = steps.indexOf(s, i + 1); assert.ok(j > i, `missing or out of order: ${s}`); i = j }
  const st = t.state
  assert.deepEqual([st.booking[0].version, Number(st.booking[0].discount_pct), st.booking[0].total_cents], [4, 10, 90000])
  assert.deepEqual(st.proposals.map((p: any) => [p.id, p.status]), [['W1-r1', 'invalidated'], ['W1-r2', 'executed']])
  assert.match(st.proposals[1].reply_body, /on 2026-11-14\./)
  assert.equal(st.approvals.length, 1)
  assert.equal(st.approvals[0].consumed_by_action, 'send-reply:W1-r2')
  assert.ok(t.steps.find((s: any) => s.step === 'Approval consumed').detail.runId, 'the run id reaches execute()')
  assert.deepEqual(st.actions.map((a: any) => a.status), ['sent'])
  assert.equal(st.providerMessages.length, 1)
  assert.deepEqual(st.mastraThreads.map((x: any) => [x.id, x.resourceId]), [['work:W1', 'org_1:booking:B-1042'], ['work:W2', 'org_1:booking:B-1042']])
  const procs = new Set(t.steps.filter((s: any) => s.kind === 'process' && /Process \d (started|exits)/.test(s.step)).map((s: any) => s.detail.pid))
  assert.equal(procs.size, 2, 'two OS processes')
  assert.equal(t.snapshots.length, 14, 'one SQL snapshot per step')
})

for (const tz of ['Asia/Dubai', 'America/Los_Angeles']) {
  test(`scenario: same reply and same content hash under TZ=${tz}`, () => {
    const t = runScenario(tz)
    const r2 = t.state.proposals.find((p: any) => p.id === 'W1-r2')
    assert.match(r2.reply_body, /on 2026-11-14\./)
    assert.equal(r2.content_hash, base().state.proposals.find((p: any) => p.id === 'W1-r2').content_hash)
  })
}
