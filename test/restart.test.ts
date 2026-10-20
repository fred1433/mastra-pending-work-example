import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshWorld, at, one, count, child } from './helpers.ts'

test('restart: process 1 suspends for approval and exits; process 2 resumes from Postgres alone', async () => {
  const { db, close } = await freshWorld({ assistant: false })
  try {
    const first = await child(['suspend-w1'])
    assert.equal(first.code, 0, first.stderr)
    assert.equal(first.out.proposal.status, 'pending_approval')
    const runId = first.out.proposal.mastra_run_id
    assert.ok(runId)
    // Same database, nothing wiped. A new OS process with empty memory picks the run up.
    const second = await child(['approve-resume', 'W1-r1', at(60).toISOString()])
    assert.equal(second.code, 0, second.stderr)
    assert.notEqual(second.out.pid, first.out.pid)
    assert.notEqual(second.out.pid, process.pid)
    assert.deepEqual(second.out.suspendedRunsSeen, [runId], 'Mastra found the suspended run in storage')
    assert.equal(second.out.approval.outcome, 'approved')
    assert.equal((await one(db, `select status from app.proposals where id = 'W1-r1'`)).status, 'executed')
    assert.equal(await count(db, 'app.actions', `key = 'send-reply:W1-r1' and status = 'pending'`), 1)
    assert.ok((await one(db, `select consumed_at from app.approvals where proposal_id = 'W1-r1'`)).consumed_at)
  } finally { await close() }
})
