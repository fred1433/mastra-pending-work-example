// Counter-examples raised in review, each reproduced as a test before the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RequestContext } from '@mastra/core/request-context'
import { freshWorld, discountPending, at, one, many, count, child, SARAH_ASKS } from './helpers.ts'
import { receiveEmail, addInternalNote, staffEditsBooking, setDeadline } from '../src/ingest.ts'
import { approveProposal, draftProposal, executeProposal } from '../src/proposals.ts'
import { runDue, resumeProposalRun, wakeWork, workerTick } from '../src/worker.ts'
import { claimDue } from '../src/wake.ts'
import { dispatchOne } from '../src/outbox.ts'
import { buildTools } from '../src/agent/tools.ts'
import { buildAssistant } from '../src/agent/assistant.ts'
import { ACTION_LEASE_MS } from '../src/config.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const later = (d: Date, ms: number) => new Date(d.getTime() + ms)
const LONG = 60 * 60_000 // past any lease

async function approved() {
  const w = await freshWorld()
  const r1 = await discountPending(w.db, w.a)
  await approveProposal(w.db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })
  return { ...w, r1 }
}

test('authorisation: a later 5% decision stops an approved 10% proposal, without consuming the approval', async () => {
  const { db, close, r1 } = await approved()
  try {
    await addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_maya', refWorkItemId: 'W1', decision: { approve: true, maxPct: 5 }, body: '5% at most after all.', at: at(31) })
    const res: any = await executeProposal(db, r1.id, { workItemId: 'W1', at: at(32) })
    assert.notEqual(res.status, 'executed')
    assert.equal((await one(db, 'select consumed_at from app.approvals')).consumed_at, null)
    assert.equal(await count(db, 'app.actions'), 0)
    assert.equal(Number((await one(db, 'select discount_pct from app.bookings')).discount_pct), 0)
    assert.equal(await count(db, 'app.discount_authorizations', 'not revoked'), 1, 'only the current decision is active')
  } finally { await close() }
})

test('authorisation: a decline arriving during execution waits for the booking lock', async () => {
  const { db, close, r1 } = await approved()
  try {
    let declineDoneEarly = false
    let decline!: Promise<unknown>
    const res: any = await executeProposal(db, r1.id, { workItemId: 'W1', at: at(32), pause: async label => {
      if (label !== 'checked') return
      decline = addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_maya', refWorkItemId: 'W1', decision: { approve: false }, body: 'No discount.', at: at(32) })
      decline.then(() => { declineDoneEarly = true }, () => { declineDoneEarly = true })
      await sleep(400)
    } })
    assert.equal(declineDoneEarly, false, 'the decline must not commit while execution holds its checks')
    await decline
    assert.equal(res.status, 'executed')
    assert.equal(await count(db, 'app.discount_authorizations', 'not revoked'), 0, 'the decline applies after')
  } finally { await close() }
})

test('durability: a wake-up claimed by a process that dies is processed by the next one', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
    const dead = await child(['claim-then-die', at(2).toISOString()])
    assert.equal(dead.signal, 'SIGKILL')
    await runDue(db, a, later(at(2), LONG))
    assert.equal((await one(db, `select waiting_for from app.work_items where id = 'W1'`)).waiting_for, 'manager_decision')
  } finally { await close() }
})

test('durability: a deadline claimed by a process that dies is processed by the next one', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
    await runDue(db, a, at(2))
    await setDeadline(db, 'W1', at(48 * 60), at(3))
    const dead = await child(['claim-then-die', at(48 * 60).toISOString()])
    assert.equal(dead.signal, 'SIGKILL')
    await runDue(db, a, later(at(48 * 60), LONG))
    assert.equal(await count(db, 'app.trace', `step = 'Run started for W1'`), 2, 'the deadline still produced a run')
  } finally { await close() }
})

test('durability: a crash between Mastra suspending and the app linking the run is reconciled', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const dead = await child(['suspend-crash-before-link'])
    assert.equal(dead.signal, 'SIGKILL')
    await runDue(db, a, later(at(25), LONG))
    const ps = await many(db, 'select id, status, mastra_run_id from app.proposals order by id')
    assert.deepEqual(ps.map(p => [p.id, p.status]), [['W1-r1', 'pending_approval']], 'linked, not redrafted')
    assert.ok(ps[0].mastra_run_id)
  } finally { await close() }
})

test('revision: an approved revision cannot run once a newer revision exists', async () => {
  const { db, a, close, r1 } = await approved()
  try {
    const d: any = await draftProposal(db, { workItemId: 'W1', discountPct: 10, to: ['sarah@northfield.example'], subject: r1.reply_subject, body: r1.reply_body.replace('Kind regards', 'Best regards') }, at(31))
    assert.equal(d.status, 'drafted')
    await resumeProposalRun(db, a, r1.id, at(32))
    assert.notEqual((await one(db, `select status from app.proposals where id = 'W1-r1'`)).status, 'executed')
    assert.equal(await count(db, 'app.actions'), 0)
    assert.ok(['draft', 'pending_approval'].includes((await one(db, `select status from app.proposals where id = 'W1-r2'`)).status))
  } finally { await close() }
})

test('read: a draft written from a read the booking has since moved past is refused', async () => {
  const { db, close } = await freshWorld({ assistant: false })
  try {
    await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
    await addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_maya', refWorkItemId: 'W1', decision: { approve: true, maxPct: 10 }, body: 'OK for 10%.', at: at(3) })
    const rc = new RequestContext(); rc.set('workItemId', 'W1'); rc.set('now', at(4).toISOString())
    const ctx: any = await (buildTools(db).readWorkContext as any).execute({ workItemId: 'W1' }, { requestContext: rc })
    assert.equal(ctx.booking.version, 1)
    await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { title: 'Renamed event' }, at: at(5) })
    const d: any = await draftProposal(db, { workItemId: 'W1', discountPct: 10, to: ['sarah@northfield.example'], subject: 'Re: Discount', body: `Hi Sarah, for ${ctx.booking.title} the total is now £720.00.` }, at(6))
    assert.equal(d.status, 'rejected')
    assert.match(d.reason, /since it was read/)
  } finally { await close() }
})

test('permission: a manager from another organisation cannot authorise', async () => {
  const { db, close } = await freshWorld({ assistant: false })
  try {
    await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
    await assert.rejects(addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_omar', refWorkItemId: 'W1', decision: { approve: true, maxPct: 10 }, body: 'OK', at: at(3) }), /organisation/)
    assert.equal(await count(db, 'app.discount_authorizations'), 0)
  } finally { await close() }
})

test('permission: a manager from another organisation cannot approve', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    const res: any = await approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_omar', at: at(30) })
    assert.equal(res.outcome, 'refused')
    assert.equal(await count(db, 'app.approvals'), 0)
  } finally { await close() }
})

test('permission: execute() rechecks the approver, not only the approval row', async () => {
  const { db, close, r1 } = await approved()
  try {
    await db.query(`update app.approvals set approved_by = 'u_omar'`)
    const res: any = await executeProposal(db, r1.id, { workItemId: 'W1', at: at(31) })
    assert.notEqual(res.status, 'executed')
    assert.equal(await count(db, 'app.actions'), 0)
  } finally { await close() }
})

test('locks: a CRM edit during execution does not deadlock; both complete in order', async () => {
  const { db, close, r1 } = await approved()
  try {
    let edit!: Promise<unknown>
    const exec = executeProposal(db, r1.id, { workItemId: 'W1', at: at(31), pause: async label => {
      if (label !== 'first-lock') return
      edit = staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { title: 'Edited during execution' }, at: at(31) })
      edit.catch(() => {})
      await sleep(300)
    } })
    const [e, x] = await Promise.allSettled([exec, (async () => { await sleep(50); while (!edit) await sleep(10); return edit })()])
    assert.equal(e.status, 'fulfilled', String((e as any).reason))
    assert.equal(x.status, 'fulfilled', String((x as any).reason))
    assert.equal(await count(db, 'app.actions'), 1)
  } finally { await close() }
})

test('intake, two messages at once in one thread converge on one work item', async () => {
  const { db, close } = await freshWorld({ assistant: false })
  try {
    const pause = () => sleep(200)
    await Promise.all([
      receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2), pause }),
      receiveEmail(db, { conversationId: 'A', externalId: 'a2', from: 'sarah@northfield.example', body: 'Also, can we start at 7pm?', at: at(2), pause }),
    ])
    assert.equal(await count(db, 'app.work_items'), 1)
  } finally { await close() }
})

test('intake, an explicitly separate request in the same thread opens its own work item', async () => {
  const { db, close } = await freshWorld({ assistant: false })
  try {
    await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
    await receiveEmail(db, { conversationId: 'A', externalId: 'a2', from: 'sarah@northfield.example', body: 'Separately: can you send the invoice to finance?', requestKey: 'invoice', at: at(3) })
    assert.equal(await count(db, 'app.work_items'), 2)
  } finally { await close() }
})

test('audience: a subject line repeating an internal note is rejected', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await discountPending(db, a)
    const r: any = await draftProposal(db, { workItemId: 'W1', discountPct: 10, to: ['sarah@northfield.example'], subject: 'OK for 10%. Repeat client, and the margin on this menu covers it.', body: 'Hi Sarah, the total is now £720.00.' }, at(26))
    assert.equal(r.status, 'rejected')
    assert.match(r.reason, /internal note/)
  } finally { await close() }
})

test('approval: clicking approve again after an invalidation reports the invalidation', async () => {
  const { db, close, r1 } = await approved()
  try {
    await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { guests: 10 }, at: at(31) })
    const again: any = await approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(32) })
    assert.equal(again.outcome, 'refused')
    assert.match(again.reason, /invalidated/)
  } finally { await close() }
})

test('wake: an urgent wake-up stays urgent when an ordinary edit follows', async () => {
  const { db, close } = await freshWorld({ assistant: false })
  try {
    await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
    await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { title: 'Small edit' }, at: at(2.5) })
    const due = await claimDue(db, at(2.6))
    assert.deepEqual(due.map((d: any) => d.workItemId), ['W1'])
  } finally { await close() }
})

test('work state: a refusal in execute() puts the work item back to waiting, never stuck on an old approval', async () => {
  const { db, close, r1 } = await approved()
  try {
    await db.query('update app.discount_authorizations set revoked = true')
    await executeProposal(db, r1.id, { workItemId: 'W1', at: at(31) })
    const w = await one(db, `select status, waiting_for from app.work_items where id = 'W1'`)
    assert.deepEqual([w.status, w.waiting_for], ['waiting', 'manager_decision'])
  } finally { await close() }
})

test('wake: a redraft made at once inside a resumed run leaves no phantom wake-up behind', async () => {
  const { db, a, close, r1 } = await approved()
  try {
    await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { guests: 10 }, at: at(31) })
    const out: any = await resumeProposalRun(db, a, r1.id, at(31))
    assert.equal(out.finishReason, 'suspended')
    const due = await claimDue(db, at(40))
    assert.deepEqual(due.map((d: any) => d.workItemId), [], 'W1-r2 already waits; nothing to redraft')
  } finally { await close() }
})

test('outbox: an acknowledgement from a superseded attempt is refused, even with the same worker id', async () => {
  const { db, a, close, r1 } = await approved()
  try {
    await resumeProposalRun(db, a, r1.id, at(30))
    let releaseA!: () => void, releaseB!: () => void, aPaused!: () => void, bPaused!: () => void
    const aAt = new Promise<void>(r => (aPaused = r)), bAt = new Promise<void>(r => (bPaused = r))
    const A = dispatchOne(db, { workerId: 'worker-1', at: at(31), pause: () => new Promise<void>(r => { releaseA = r; aPaused() }) })
    await aAt
    const B = dispatchOne(db, { workerId: 'worker-1', at: later(at(31), ACTION_LEASE_MS + 1000), pause: () => new Promise<void>(r => { releaseB = r; bPaused() }) })
    await bAt
    releaseA(); const ra: any = await A
    releaseB(); const rb: any = await B
    assert.equal(ra.outcome, 'lost_lease')
    assert.notEqual(rb.outcome, 'lost_lease')
    assert.equal(await count(db, 'provider.messages'), 1)
  } finally { await close() }
})

test('atomicity: a failure while recording the send rolls back the approval and the booking change', async () => {
  const { db, close, r1 } = await approved()
  try {
    await assert.rejects(executeProposal(db, r1.id, { workItemId: 'W1', at: at(31), pause: label => { if (label === 'before-outbox') throw new Error('injected') } }), /injected/)
    assert.equal((await one(db, 'select consumed_at from app.approvals')).consumed_at, null)
    const b = await one(db, 'select version, discount_pct from app.bookings')
    assert.deepEqual([b.version, Number(b.discount_pct)], [1, 0])
    assert.equal((await one(db, `select status from app.proposals where id = 'W1-r1'`)).status, 'approved')
  } finally { await close() }
})

test('beforeApproval: an error while validating refuses the call instead of letting it reach a person', async () => {
  const { db, close } = await freshWorld({ assistant: false })
  const a2 = buildAssistant(db, { decide: (prompt: any[]) => {
    const last = prompt[prompt.length - 1]
    return last.role === 'user' ? { tool: 'submitProposal', input: { proposalId: 'W1-r1' } } : { text: 'done' }
  } })
  try {
    await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
    await addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_maya', refWorkItemId: 'W1', decision: { approve: true, maxPct: 10 }, body: 'OK for 10%.', at: at(3) })
    const rc = new RequestContext(); rc.set('workItemId', 'W1'); rc.set('now', at(4).toISOString())
    await (buildTools(db).readWorkContext as any).execute({ workItemId: 'W1' }, { requestContext: rc })
    const d: any = await draftProposal(db, { workItemId: 'W1', discountPct: 10, to: ['sarah@northfield.example'], subject: 'Re: Discount', body: 'Hi Sarah, the total is now £720.00.' }, at(5))
    assert.equal(d.status, 'drafted')
    await db.query('alter table app.bookings rename to bookings_gone')
    let out: any
    try { out = await wakeWork(db, a2, 'W1', ['test'], at(6)) } finally { await db.query('alter table app.bookings_gone rename to bookings') }
    assert.notEqual(out.finishReason, 'suspended')
  } finally { await a2.close(); await close() }
})

test('worker: one tick resumes an approved run and sends its email', async () => {
  const { db, a, close } = await approved()
  try {
    const t = await workerTick(db, a, 'worker-1', at(31))
    assert.equal(t.resumed, 1)
    assert.deepEqual(t.sent.map((r: any) => r.outcome), ['sent'])
    assert.equal(await count(db, 'provider.messages'), 1)
  } finally { await close() }
})
