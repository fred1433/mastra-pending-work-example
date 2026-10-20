import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshWorld, discountPending, at, one, count, SARAH_ASKS } from './helpers.ts'
import { receiveEmail, addInternalNote, staffEditsBooking, staffEditsContact, setDeadline } from '../src/ingest.ts'
import { claimDue, ackWake } from '../src/wake.ts'

/** Claim everything due and acknowledge it, as a worker does after each run. */
async function takeDue(db: any, t: Date) {
  const claims = await claimDue(db, t)
  for (const c of claims) await ackWake(db, c)
  return claims
}
import { approveProposal } from '../src/proposals.ts'
import { resumeProposalRun } from '../src/worker.ts'
import { dispatchOne } from '../src/outbox.ts'

async function openRequest() {
  const w = await freshWorld({ assistant: false })
  await receiveEmail(w.db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
  return w
}

test('wake: a new explicit request wakes its work item now', async () => {
  const { db, close } = await openRequest()
  try {
    const due = await takeDue(db, at(2))
    assert.deepEqual(due.map(d => [d.workItemId, d.reasons]), [['W1', ['new request']]])
  } finally { await close() }
})

test('wake: a linked human decision wakes now', async () => {
  const { db, close } = await openRequest()
  try {
    await takeDue(db, at(2))
    await addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_maya', refWorkItemId: 'W1', decision: { approve: true, maxPct: 10 }, body: 'OK for 10%', at: at(20) })
    assert.deepEqual((await takeDue(db, at(20))).map(d => d.reasons), [['manager decision linked']])
  } finally { await close() }
})

test('wake: a changed dependency invalidates at once; the redraft waits for the batch window', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await discountPending(db, a)
    await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { guests: 10 }, at: at(31) })
    assert.equal((await one(db, `select status from app.proposals where id = 'W1-r1'`)).status, 'invalidated', 'immediately')
    assert.equal((await takeDue(db, at(32))).length, 0, 'no redraft inside the window')
    assert.deepEqual((await takeDue(db, at(33))).map(d => d.workItemId), ['W1'])
  } finally { await close() }
})

test('wake: a burst of ordinary edits gives one wake-up after a quiet window, capped by a max wait', async () => {
  const { db, close } = await openRequest()
  try {
    await takeDue(db, at(2))
    for (const m of [10, 11, 12, 13]) await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { title: `Dinner v${m}` }, at: at(m) })
    assert.equal((await takeDue(db, at(14.9))).length, 0)
    const due = await takeDue(db, at(15))
    assert.deepEqual(due.map(d => [d.workItemId, d.groupedEvents]), [['W1', 4]])
    // Edits every minute never go quiet: the max wait (10 min after the first) still fires.
    for (let m = 20; m < 30; m++) await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { title: `Dinner ${m}` }, at: at(m) })
    assert.equal((await takeDue(db, at(29.9))).length, 0)
    assert.deepEqual((await takeDue(db, at(30))).map(d => d.groupedEvents), [10])
  } finally { await close() }
})

test('wake: an unrelated edit (contact phone) wakes nothing', async () => {
  const { db, close } = await openRequest()
  try {
    await takeDue(db, at(2))
    await staffEditsContact(db, { contactId: 'C-77', staffId: 'u_tom', phone: '+44 20 0000 0009', at: at(10) })
    assert.equal((await takeDue(db, at(100))).length, 0)
  } finally { await close() }
})

test('wake: events produced by the assistant are recognised by provenance and do not wake their own work', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    await approveProposal(db, { proposalId: r1.id, contentHash: r1.content_hash, staffId: 'u_tom', at: at(30) })
    await resumeProposalRun(db, a, r1.id, at(30))
    await dispatchOne(db, { workerId: 'w', at: at(30) })
    assert.equal(await count(db, 'app.events', `provenance = 'assistant'`), 2, 'booking change and sent email')
    assert.equal((await takeDue(db, at(100))).length, 0, 'no loop')
  } finally { await close() }
})

test('wake: a deadline wakes the work item from its durable state', async () => {
  const { db, close } = await openRequest()
  try {
    await takeDue(db, at(2))
    await setDeadline(db, 'W1', at(48 * 60), at(3))
    assert.equal((await takeDue(db, at(48 * 60 - 1))).length, 0)
    assert.deepEqual((await takeDue(db, at(48 * 60))).map(d => d.reasons), [['deadline reached']])
  } finally { await close() }
})
