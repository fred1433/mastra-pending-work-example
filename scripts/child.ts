// Process-level helpers for the tests: each invocation is a separate OS process sharing only Postgres.
import { connect, one } from '../src/db.ts'
import { buildAssistant } from '../src/agent/assistant.ts'
import { receiveEmail, addInternalNote } from '../src/ingest.ts'
import { approveProposal } from '../src/proposals.ts'
import { runDue, resumeProposalRun } from '../src/worker.ts'
import { dispatchOne } from '../src/outbox.ts'
import { at } from '../src/seed.ts'

const [cmd, ...args] = process.argv.slice(2)
const db = connect()
const print = (o: unknown) => console.log(JSON.stringify(o))
const barrier = async () => { const t = Number(process.env.START_AT ?? 0); while (Date.now() < t) await new Promise(r => setTimeout(r, 2)) }

if (cmd === 'suspend-w1') {
  const a = buildAssistant(db)
  await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', at: at(2), body: 'Would a 10% discount be possible for the team dinner on 14 November?' })
  await runDue(db, a, at(2))
  await addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_maya', refWorkItemId: 'W1', decision: { approve: true, maxPct: 10 }, body: 'OK for 10%. Repeat client, and the margin on this menu covers it.', at: at(25) })
  await runDue(db, a, at(25))
  const p = await one(db, `select id, status, mastra_run_id from app.proposals where id = 'W1-r1'`)
  print({ pid: process.pid, proposal: p })
}

if (cmd === 'approve-resume') {
  const a = buildAssistant(db)
  const [proposalId, iso] = args
  const { runs } = await (a.agent as any).listSuspendedRuns({ threadId: 'work:W1' })
  const p = await one(db, 'select * from app.proposals where id = $1', [proposalId])
  const approval = await approveProposal(db, { proposalId, contentHash: p.content_hash, staffId: 'u_tom', at: new Date(iso) })
  const out: any = await resumeProposalRun(db, a, proposalId, new Date(iso))
  print({ pid: process.pid, suspendedRunsSeen: runs.map((r: any) => r.runId), approval, finishReason: out.finishReason })
}

if (cmd === 'mastra-approve') {
  const a = buildAssistant(db)
  const [runId, toolCallId, iso] = args
  const { RequestContext } = await import('@mastra/core/request-context')
  const rc = new RequestContext(); rc.set('workItemId', 'W1'); rc.set('now', iso)
  await barrier()
  try {
    const out: any = await a.agent.approveToolCallGenerate({ runId, toolCallId, requestContext: rc, memory: { thread: 'work:W1', resource: 'org_1:booking:B-1042' } } as any)
    print({ pid: process.pid, ok: true, finishReason: out.finishReason })
  } catch (e: any) {
    print({ pid: process.pid, ok: false, id: e?.id ?? null, message: String(e?.message).slice(0, 160) })
  }
}

if (cmd === 'dispatch') {
  const [workerId, iso] = args
  await barrier()
  const r = await dispatchOne(db, { workerId, at: new Date(iso), crashAfterAccept: args.includes('--crash'), providerIdempotency: !args.includes('--no-idem') })
  print({ pid: process.pid, ...r })
}

process.exit(0)
