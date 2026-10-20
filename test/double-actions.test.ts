import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshWorld, discountPending, at, one, many, count, child } from './helpers.ts'
import { approveProposal, executeProposal } from '../src/proposals.ts'
import { resumeProposalRun } from '../src/worker.ts'
import { ACTION_LEASE_MS } from '../src/config.ts'

async function approvedAndExecuted() {
  const w = await freshWorld()
  const r1 = await discountPending(w.db, w.a)
  await approveProposal(w.db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })
  await resumeProposalRun(w.db, w.a, r1.id, at(30))
  assert.equal((await one(w.db, `select status from app.actions`)).status, 'pending')
  return w
}

test('double click: one approval row, the second click gets the same result back', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    const res = await Promise.all([1, 2].map(() => approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })))
    assert.deepEqual(res.map(r => r.outcome).sort(), ['already_approved', 'approved'])
    assert.equal((res[0] as any).approvalId, (res[1] as any).approvalId)
    assert.equal(await count(db, 'app.approvals'), 1)
  } finally { await close() }
})

test('two executions from different runs: one action, keyed on the proposal revision, not the runId', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    await approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })
    const res = await Promise.all(['run-a', 'run-b'].map(runId => executeProposal(db, r1.id, { workItemId: 'W1', runId, at: at(30) })))
    assert.deepEqual(res.map(r => r.status).sort(), ['already_executed', 'executed'])
    assert.deepEqual(await many(db, 'select key from app.actions'), [{ key: 'send-reply:W1-r1' }])
    const b = await one(db, `select version, total_cents from app.bookings`)
    assert.deepEqual([b.version, b.total_cents], [2, 72000], 'discount applied once')
  } finally { await close() }
})

test('observed on @mastra/core 1.78.0: a second concurrent resume of the same run is rejected by Mastra', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    await approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })
    const START_AT = String(Date.now() + 4000)
    const res = await Promise.all([1, 2].map(() => child(['mastra-approve', r1.mastra_run_id, r1.mastra_tool_call_id, at(30).toISOString()], { START_AT })))
    const outs = res.map(r => r.out)
    assert.equal(outs.filter(o => o.ok).length, 1, JSON.stringify(outs))
    const rejected = outs.find(o => !o.ok)
    assert.match(rejected.message, /already claimed|could not find a suspended run/)
    assert.equal(await count(db, 'app.actions'), 1)
  } finally { await close() }
})

test('two worker processes on the same send: exclusive claim, one provider message', async () => {
  const { db, close } = await approvedAndExecuted()
  try {
    const START_AT = String(Date.now() + 3000)
    const res = await Promise.all(['worker-a', 'worker-b'].map(w => child(['dispatch', w, at(31).toISOString()], { START_AT })))
    assert.notEqual(res[0].out.pid, res[1].out.pid)
    assert.deepEqual(res.map(r => r.out.outcome).sort(), ['nothing_to_claim', 'sent'])
    assert.equal(await count(db, 'provider.messages'), 1)
  } finally { await close() }
})

test('provider accepted, process killed before the local ack: with an idempotency key, no second email', async () => {
  const { db, close } = await approvedAndExecuted()
  try {
    const crashed = await child(['dispatch', 'worker-a', at(31).toISOString(), '--crash'])
    assert.equal(crashed.signal, 'SIGKILL')
    assert.equal(await count(db, 'provider.messages'), 1)
    assert.equal((await one(db, 'select status from app.actions')).status, 'claimed', 'local state never heard back')
    const later = new Date(at(31).getTime() + ACTION_LEASE_MS + 1000).toISOString()
    const retry = await child(['dispatch', 'worker-b', later])
    assert.equal(retry.out.outcome, 'deduplicated_by_provider')
    assert.equal(await count(db, 'provider.messages'), 1)
    const act = await one(db, 'select status, provider_message_id from app.actions')
    assert.equal(act.status, 'sent')
    assert.equal(act.provider_message_id, (await one(db, 'select id from provider.messages')).id)
  } finally { await close() }
})

test('same crash without provider idempotency: delivery_unknown is shown, nothing is resent', async () => {
  const { db, close } = await approvedAndExecuted()
  try {
    const crashed = await child(['dispatch', 'worker-a', at(31).toISOString(), '--crash', '--no-idem'])
    assert.equal(crashed.signal, 'SIGKILL')
    const later = new Date(at(31).getTime() + ACTION_LEASE_MS + 1000).toISOString()
    const retry = await child(['dispatch', 'worker-b', later, '--no-idem'])
    assert.equal(retry.out.outcome, 'delivery_unknown')
    assert.equal(await count(db, 'provider.messages'), 1)
    assert.equal((await one(db, 'select status from app.actions')).status, 'delivery_unknown')
  } finally { await close() }
})
