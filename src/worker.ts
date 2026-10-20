// The single persistent worker (a long-running service such as Railway). It consumes wake-ups recorded by the web app,
// runs the agent on the work item's own thread, and drives approvals through Mastra's suspend/resume.
import { RequestContext } from '@mastra/core/request-context'
import type { Db } from './db.ts'
import { one, many } from './db.ts'
import { trace } from './trace.ts'
import { claimDue } from './wake.ts'
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
  if (out.finishReason === 'suspended' && out.suspendPayload?.toolName === 'submitProposal') {
    await markPendingApproval(db, out.suspendPayload.args.proposalId, out.runId, out.suspendPayload.toolCallId, at)
  }
  return out
}

export async function wakeWork(db: Db, a: Assistant, workItemId: string, reasons: string[], at: Date, extra = '') {
  const w = await one(db, 'select * from app.work_items where id = $1', [workItemId])
  await trace(db, at, 'worker', 'process', `Run started for ${w.id}`, { workItemId: w.id, reasons, mastraThread: w.mastra_thread, mastraResource: w.mastra_resource })
  const out: any = await withModelTrace(db, at, w.id, () => a.agent.generate(
    `<wake work="${w.id}" reason="${reasons.join('; ')}"${extra}/>`,
    { memory: { thread: w.mastra_thread, resource: w.mastra_resource }, requestContext: context(w.id, at), maxSteps: 10 } as any))
  return afterRun(db, out, at)
}

export async function runDue(db: Db, a: Assistant, at: Date) {
  const due = await claimDue(db, at)
  const results = []
  for (const d of due) results.push({ workItemId: d.workItemId, groupedEvents: d.groupedEvents, out: await wakeWork(db, a, d.workItemId, d.reasons, at) })
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

export async function resumeApproved(db: Db, a: Assistant, at: Date) {
  const rows = await many(db, `select id from app.proposals where status = 'approved' and mastra_run_id is not null and not run_closed order by id`)
  const out = []
  for (const r of rows) out.push(await resumeProposalRun(db, a, r.id, at))
  return out
}
