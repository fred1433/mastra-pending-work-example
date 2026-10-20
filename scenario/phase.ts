// One phase of the scenario per OS process. Phase 1 ends with a proposal waiting for approval and exits.
// Phase 2 is a fresh process: nothing from phase 1 survives except Postgres.
import { connect, one, many } from '../src/db.ts'
import { at } from '../src/seed.ts'
import { trace } from '../src/trace.ts'
import { receiveEmail, addInternalNote, staffEditsBooking, staffEditsContact } from '../src/ingest.ts'
import { approveProposal } from '../src/proposals.ts'
import { dispatchOne } from '../src/outbox.ts'
import { buildAssistant } from '../src/agent/assistant.ts'
import { runDue, withdrawInvalidated, resumeApproved } from '../src/worker.ts'

const db = connect()
const a = buildAssistant(db)
const phase = process.argv[2]

if (phase === '1') {
  await trace(db, at(0), 'worker', 'process', 'Process 1 started', { pid: process.pid })
  await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', at: at(2),
    body: 'Hello, we are booked for the team dinner on 14 November. Would a 10% discount be possible? We have held our last three events with you.' })
  await runDue(db, a, at(2))

  await receiveEmail(db, { conversationId: 'B', externalId: 'b1', from: 'dev@northfield.example', at: at(10),
    body: 'Hi, quick update for the 14th: we will be 10 people, not 8. Two of them are vegetarian.' })
  await runDue(db, a, at(10))

  await addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_maya', refWorkItemId: 'W1', decision: { approve: true, maxPct: 10 }, at: at(25),
    body: 'OK for 10%. Repeat client, and the margin on this menu covers it.' })
  await runDue(db, a, at(25))

  await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { guests: 10 }, at: at(31) })
  await withdrawInvalidated(db, a, at(31))
  const r1 = await one(db, `select * from app.proposals where id = 'W1-r1'`)
  await approveProposal(db, { proposalId: 'W1-r1', contentHash: r1.content_hash, staffId: 'u_tom', at: at(32) })
  await staffEditsBooking(db, { bookingId: 'B-1042', staffId: 'u_tom', patch: { title: 'Northfield team dinner (10 guests)' }, at: at(32.5) })
  await staffEditsContact(db, { contactId: 'C-77', staffId: 'u_tom', phone: '+44 20 0000 0002', at: at(33) })

  await runDue(db, a, at(33.5)) // nothing due yet: the batch window is still open
  await runDue(db, a, at(34.5))
  await trace(db, at(35), 'worker', 'process', 'Process 1 exits', { pid: process.pid, waiting: (await many(db, `select id from app.proposals where status = 'pending_approval'`)).map(r => r.id) })
}

if (phase === '2') {
  await trace(db, at(50), 'worker', 'process', 'Process 2 started, empty memory', { pid: process.pid })
  const { runs } = await (a.agent as any).listSuspendedRuns({ threadId: 'work:W1' })
  await trace(db, at(50), 'mastra', 'state', 'Suspended run found in Postgres', { runs: runs.map((r: any) => r.runId) })
  const r2 = await one(db, `select * from app.proposals where status = 'pending_approval' order by revision desc limit 1`)
  // Tom double-clicks "Approve".
  await Promise.all([1, 2].map(() => approveProposal(db, { proposalId: r2.id, contentHash: r2.content_hash, staffId: 'u_tom', at: at(51) })))
  await resumeApproved(db, a, at(51))
  await dispatchOne(db, { workerId: 'worker-2', at: at(51.2) })
  await runDue(db, a, at(60))
  await trace(db, at(60), 'worker', 'process', 'Process 2 exits', { pid: process.pid })
}

process.exit(0)
