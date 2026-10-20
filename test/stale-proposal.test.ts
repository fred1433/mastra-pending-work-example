import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshWorld, discountPending, at, one, count } from './helpers.ts'
import { staffEditsBooking } from '../src/ingest.ts'
import { approveProposal, draftProposal, executeProposal } from '../src/proposals.ts'
import { buildAssistant } from '../src/agent/assistant.ts'
import { runDue, withdrawInvalidated, resumeProposalRun, wakeWork } from '../src/worker.ts'

test('stale: an invalidated proposal cannot be approved, and the redraft waits for its own approval', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    assert.equal(r1.status, 'pending_approval')
    assert.equal(r1.based_on_booking_version, 1)
    await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { guests: 10 }, at: at(31) })
    assert.equal((await one(db, `select status from app.proposals where id = 'W1-r1'`)).status, 'invalidated')
    const late = await approveProposal(db, { proposalId: 'W1-r1', contentHash: r1.content_hash, staffId: 'u_tom', at: at(32) })
    assert.equal(late.outcome, 'refused')
    await withdrawInvalidated(db, a, at(32))
    await runDue(db, a, at(34))
    const r2 = await one(db, `select * from app.proposals where id = 'W1-r2'`)
    assert.equal(r2.status, 'pending_approval')
    assert.equal(r2.based_on_booking_version, 2)
    assert.equal(r2.effects.totalAfterCents, 90000)
    assert.equal(await count(db, 'app.approvals'), 0, 'no approval carried over')
    const reuse = await approveProposal(db, { proposalId: 'W1-r2', contentHash: r1.content_hash, staffId: 'u_tom', at: at(35) })
    assert.equal(reuse.outcome, 'refused', 'the hash approved for r1 does not approve r2')
  } finally { await close() }
})

test('stale: approved, then the booking changes before execution; execute() refuses and a new revision waits', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    assert.equal((await approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })).outcome, 'approved')
    await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { guests: 10 }, at: at(31) })
    // The worker resumes the old run before the withdrawal pass: execute() is the last line.
    const out: any = await resumeProposalRun(db, a, r1.id, at(31))
    assert.equal(out.finishReason, 'suspended', 'the run regenerated and suspended again')
    assert.equal(await count(db, 'app.trace', `step = 'Execution refused in execute()'`), 1)
    assert.equal(await count(db, 'app.actions'), 0, 'nothing to send')
    assert.equal((await one(db, `select consumed_at from app.approvals where proposal_id = 'W1-r1'`)).consumed_at, null)
    const r2 = await one(db, `select * from app.proposals where id = 'W1-r2'`)
    assert.equal(r2.status, 'pending_approval')
    assert.equal(await count(db, 'app.approvals', `proposal_id = 'W1-r2'`), 0)
  } finally { await close() }
})

test('stale: a change made behind the application (raw SQL) is still caught in execute()', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    await approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })
    await db.query(`update app.bookings set guests = 12, version = version + 1 where id = 'B-1042'`)
    const out: any = await resumeProposalRun(db, a, r1.id, at(31))
    assert.equal(out.finishReason, 'suspended')
    assert.equal(await count(db, 'app.actions'), 0)
    assert.equal((await one(db, `select based_on_booking_version as v from app.proposals where id = 'W1-r2'`)).v, 2)
  } finally { await close() }
})

test('stale: editing text, recipients or effects after approval never reuses the approval', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await discountPending(db, a)
    const edits = [
      `update app.proposals set reply_body = reply_body || ' Next time we can do 20%.' where id = $1`,
      `update app.proposals set reply_to = array_append(reply_to, 'dev@northfield.example') where id = $1`,
      `update app.proposals set effects = jsonb_set(effects, '{discountPct}', '15') where id = $1`,
    ]
    for (const [i, sql] of edits.entries()) {
      const p = await one(db, `select * from app.proposals where status = 'pending_approval'`)
      assert.equal(p.revision, i + 1)
      await approveProposal(db, { proposalId: p.id, contentHash: p.content_hash, staffId: 'u_tom', at: at(30 + i) })
      await db.query(sql, [p.id])
      const out: any = await resumeProposalRun(db, a, p.id, at(30 + i))
      assert.equal(out.finishReason, 'suspended', `edit ${i + 1}: a fresh revision waits`)
      assert.equal(await count(db, 'app.actions'), 0, `edit ${i + 1}: nothing sent`)
      assert.equal((await one(db, 'select consumed_at from app.approvals where proposal_id = $1', [p.id])).consumed_at, null)
    }
    assert.equal(await count(db, 'app.trace', `step = 'Execution refused in execute()' and detail->>'reason' like '%no longer matches%'`), 3)
  } finally { await close() }
})

test('beforeApproval: a draft that is already stale is never shown to a person', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await discountPending(db, a)
    await db.query(`update app.proposals set status = 'superseded', run_closed = true where id = 'W1-r1'`)
    const d: any = await draftProposal(db, { workItemId: 'W1', discountPct: 10, to: ['sarah@northfield.example'], subject: 'Re: Discount for our team dinner', body: 'Hi Sarah, for 8 guests the total is now £720.00 instead of £800.00.' }, at(26))
    assert.equal(d.status, 'drafted')
    await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { guests: 9 }, at: at(27) })
    // A model that submits this draft straight away, to reach the hook with a stale proposal.
    const submitter = buildAssistant(db, { decide: (prompt: any[]) => prompt[prompt.length - 1].role === 'user' ? { tool: 'submitProposal', input: { proposalId: d.proposalId } } : { text: 'done' } })
    const out: any = await wakeWork(db, submitter, 'W1', ['test'], at(27)).finally(() => submitter.close())
    assert.notEqual(out.finishReason, 'suspended')
    assert.equal(await count(db, 'app.trace', `step = 'beforeApproval: not shown to a person'`), 1)
    assert.equal((await one(db, 'select mastra_run_id from app.proposals where id = $1', [d.proposalId])).mastra_run_id, null)
  } finally { await close() }
})

test('revoked authorisation: execute() refuses without consuming the approval, in one transaction', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    await approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })
    await db.query('update app.discount_authorizations set revoked = true')
    const res: any = await executeProposal(db, r1.id, { workItemId: 'W1', at: at(31) })
    assert.equal(res.status, 'unauthorised')
    const ap = await one(db, 'select consumed_at, consumed_by_action from app.approvals')
    assert.deepEqual([ap.consumed_at, ap.consumed_by_action], [null, null])
    assert.equal(await count(db, 'app.actions'), 0)
    assert.equal((await one(db, `select status from app.proposals where id = 'W1-r1'`)).status, 'invalidated')
    const again: any = await executeProposal(db, r1.id, { workItemId: 'W1', at: at(32) })
    assert.notEqual(again.status, 'executed')
    assert.equal(await count(db, 'app.actions'), 0)
  } finally { await close() }
})
