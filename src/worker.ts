// The single persistent worker (a long-running service such as Railway). It consumes wake-ups recorded by the web app,
// runs the agent on the work item's own thread, and drives approvals through Mastra's suspend/resume.
import { RequestContext } from '@mastra/core/request-context'
import type { Db } from './db.ts'
import { one, many } from './db.ts'
import { trace } from './trace.ts'
import { claimDue, ackWake, releaseWake } from './wake.ts'
import { dispatchOne } from './outbox.ts'
import { markPendingApproval } from './proposals.ts'
import { observeModel } from './agent/fake-model.ts'
import type { Assistant } from './agent/assistant.ts'
import { MODEL_WINDOW_MESSAGES } from './config.ts'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function context(workItemId: string, at: Date, runId?: string) {
  const rc = new RequestContext()
  rc.set('workItemId', workItemId)
  rc.set('now', at.toISOString())
  if (runId) rc.set('runId', runId)
  return rc
}

async function withModelTrace<T>(db: Db, at: Date, workItemId: string, fn: () => Promise<T>) {
  const seen: { messages: number; roles: string[]; wakesVisible: number; lastTool?: string }[] = []
  const wakes = Number((await one(db, `select count(*) as n from app.trace where step = $1`, [`Run started for ${workItemId}`])).n)
  observeModel(s => seen.push(s))
  try { return await fn() } finally {
    observeModel(null)
    if (seen.length) {
      const first = seen[0]
      await trace(db, at, 'assistant', 'model', 'Model calls', {
        workItemId, calls: seen.length, steps: seen.map(s => s.lastTool ?? 'text reply'),
        window: `${plural(first.roles.filter(r => r !== 'system').length, 'message')} at the first call; ${first.wakesVisible} of ${plural(Math.max(wakes, first.wakesVisible), 'wake-up')} of this thread still visible (memory recalls the last ${MODEL_WINDOW_MESSAGES} stored messages; tool calls and their results reach the prompt as separate messages)`,
      })
    }
  }
}

async function afterRun(db: Db, out: any, at: Date) {
  if (process.env.CRASH_BEFORE_LINK && out.finishReason === 'suspended') process.kill(process.pid, 'SIGKILL')
  if (out.finishReason === 'suspended' && out.suspendPayload?.toolName === 'submitProposal') {
    await markPendingApproval(db, out.suspendPayload.args.proposalId, out.runId, out.suspendPayload.toolCallId, at)
  }
  return out
}

/**
 * Mastra may have suspended a run whose link to the proposal was never written (a crash between the two).
 * Before a new run on the thread, find such runs in Mastra's storage and link them instead of redrafting.
 */
export async function reconcileSuspended(db: Db, a: Assistant, workItemId: string, at: Date) {
  const w = await one(db, 'select * from app.work_items where id = $1', [workItemId])
  const { runs } = await (a.agent as any).listSuspendedRuns({ threadId: w.mastra_thread, resourceId: w.mastra_resource })
  let linked = 0
  for (const r of runs) {
    for (const tc of r.toolCalls ?? []) {
      const proposalId = (tc.args as any)?.proposalId
      if (tc.toolName !== 'submitProposal' || !proposalId) continue
      const p = await one(db, 'select id, mastra_run_id from app.proposals where id = $1', [proposalId])
      if (p && !p.mastra_run_id) {
        await markPendingApproval(db, proposalId, r.runId, tc.toolCallId, at)
        await trace(db, at, 'worker', 'state', 'Suspended run found in Mastra storage and linked', { proposalId, runId: r.runId })
        linked++
      }
    }
  }
  return linked
}

export async function wakeWork(db: Db, a: Assistant, workItemId: string, reasons: string[], at: Date) {
  const w = await one(db, 'select * from app.work_items where id = $1', [workItemId])
  await trace(db, at, 'worker', 'process', `Run started for ${w.id}`, { workItemId: w.id, reasons, mastraThread: w.mastra_thread, mastraResource: w.mastra_resource })
  const out: any = await withModelTrace(db, at, w.id, () => a.agent.generate(
    `<wake work="${w.id}" reason="${reasons.join('; ')}"/>`,
    { memory: { thread: w.mastra_thread, resource: w.mastra_resource }, requestContext: context(w.id, at), maxSteps: 10 } as any))
  return afterRun(db, out, at)
}

/**
 * Claims one due wake-up at a time under a lease, runs it, and acknowledges it only once the run reached a
 * durable result (suspended and linked, waiting recorded, or closed). On an error the claim is released.
 */
export async function runDue(db: Db, a: Assistant, at: Date, opts: { workerId?: string; onEach?: (workItemId: string) => Promise<void> } = {}) {
  const workerId = opts.workerId ?? 'worker'
  const results = []
  for (;;) {
    const [claim] = await claimDue(db, at, workerId, 1)
    if (!claim) break
    try {
      await reconcileSuspended(db, a, claim.workItemId, at)
      const out = await wakeWork(db, a, claim.workItemId, claim.reasons, at)
      await ackWake(db, claim)
      results.push({ workItemId: claim.workItemId, groupedEvents: claim.groupedEvents, out })
      await opts.onEach?.(claim.workItemId)
    } catch (e) {
      await releaseWake(db, claim)
      throw e
    }
  }
  return results
}

/** Close the suspended Mastra call of every proposal the app invalidated. */
export async function withdrawInvalidated(db: Db, a: Assistant, at: Date) {
  const rows = await many(db, `select p.*, w.mastra_thread, w.mastra_resource from app.proposals p join app.work_items w on w.id = p.work_item_id
                               where p.status in ('invalidated','superseded') and p.mastra_run_id is not null and not p.run_closed`)
  for (const p of rows) {
    await withModelTrace(db, at, p.work_item_id, () => a.agent.declineToolCallGenerate({
      runId: p.mastra_run_id, toolCallId: p.mastra_tool_call_id, reason: p.status_reason ?? p.status,
      memory: { thread: p.mastra_thread, resource: p.mastra_resource }, requestContext: context(p.work_item_id, at),
    } as any))
    await db.query('update app.proposals set run_closed = true where id = $1', [p.id])
    await trace(db, at, 'mastra', 'state', `Suspended call for ${p.id} declined`, { proposalId: p.id, runId: p.mastra_run_id, reason: p.status_reason })
  }
  return rows.length
}

/** Resume the run behind one proposal. Mastra re-runs the tool; execute() decides. */
export async function resumeProposalRun(db: Db, a: Assistant, proposalId: string, at: Date) {
  const p = await one(db, `select p.*, w.mastra_thread, w.mastra_resource from app.proposals p join app.work_items w on w.id = p.work_item_id where p.id = $1`, [proposalId])
  await trace(db, at, 'worker', 'process', `Resuming the run for ${p.id}`, { proposalId: p.id, runId: p.mastra_run_id, proposalStatus: p.status })
  const out: any = await withModelTrace(db, at, p.work_item_id, () => a.agent.approveToolCallGenerate({
    runId: p.mastra_run_id, toolCallId: p.mastra_tool_call_id,
    memory: { thread: p.mastra_thread, resource: p.mastra_resource }, requestContext: context(p.work_item_id, at, p.mastra_run_id), maxSteps: 10,
  } as any))
  await db.query('update app.proposals set run_closed = true where id = $1', [p.id])
  return afterRun(db, out, at)
}

/**
 * One pass of the worker loop, as it would run on a long-lived service: close invalidated runs, resume
 * approved ones, run due wake-ups, then send what the outbox holds. Polling or LISTEN/NOTIFY decides when.
 */
export async function workerTick(db: Db, a: Assistant, workerId: string, at: Date) {
  const withdrawn = await withdrawInvalidated(db, a, at)
  const resumed = (await resumeApproved(db, a, at)).length
  const woken = (await runDue(db, a, at, { workerId })).length
  const sent = []
  for (;;) {
    const r = await dispatchOne(db, { workerId, at })
    if (r.outcome === 'nothing_to_claim') break
    sent.push(r)
  }
  return { withdrawn, resumed, woken, sent }
}

export async function resumeApproved(db: Db, a: Assistant, at: Date) {
  const rows = await many(db, `select id from app.proposals where status = 'approved' and mastra_run_id is not null and not run_closed order by id`)
  const out = []
  for (const r of rows) out.push(await resumeProposalRun(db, a, r.id, at))
  return out
}
