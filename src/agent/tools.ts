import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { Db } from '../db.ts'
import { one, many } from '../db.ts'
import { trace, money } from '../trace.ts'
import { draftProposal, checkBeforeApproval, executeProposal } from '../proposals.ts'

// The worker sets these on the RequestContext from the wake-up it claimed. Tools trust them, not the model.
// execute() receives a RequestContext; beforeApproval (1.78.0) receives a plain object. Read both, and fail
// closed: a hook that throws lets the call through to the approval gate, so it must not throw on bad input.
function scope(ctx: any) {
  const rc = ctx?.requestContext
  const get = (k: string) => (typeof rc?.get === 'function' ? rc.get(k) : rc?.[k])
  const workItemId = get('workItemId')
  const at = new Date(String(get('now')))
  if (!workItemId || Number.isNaN(at.getTime())) throw new Error('tool called without a worker scope')
  const runId = get('runId')
  return { workItemId: String(workItemId), at, runId: runId ? String(runId) : undefined }
}
const outOfScope = (asked: string, allowed: string) => ({ status: 'refused', reason: `work item ${asked} is outside this run (${allowed})` })

export function buildTools(db: Db) {
  const readWorkContext = createTool({
    id: 'readWorkContext',
    description: 'Read the current booking from Postgres and every source linked to this request, with provenance and audience.',
    inputSchema: z.object({ workItemId: z.string() }),
    execute: async (input, ctx) => {
      const s = scope(ctx)
      if (input.workItemId !== s.workItemId) return outOfScope(input.workItemId, s.workItemId)
      const w = await one(db, 'select * from app.work_items where id = $1', [s.workItemId])
      const b = await one(db, 'select * from app.bookings where id = $1', [w.booking_id])
      const sources = await many(db,
        `select s.link, s.reason, m.id, m.author_kind, m.author_ref, m.body, cv.id as conversation, cv.subject, cv.audience, cv.channel
         from app.work_sources s join app.messages m on m.id = s.message_id join app.conversations cv on cv.id = m.conversation_id
         where s.work_item_id = $1 order by m.at`, [w.id])
      const origin = sources.find(x => x.link === 'origin')
      const participants = origin ? await many(db, 'select address, name from app.participants where conversation_id = $1', [origin.conversation]) : []
      const auth = await one(db, `select a.max_pct, a.scope, s.name from app.discount_authorizations a join app.staff s on s.id = a.granted_by
                                  where a.work_item_id = $1 and not a.revoked order by a.id desc limit 1`, [w.id])
      const latest = await one(db, 'select id, status, status_reason from app.proposals where work_item_id = $1 order by revision desc limit 1', [w.id])
      // Other open work on the same booking: visible as facts, not merged into this thread.
      const siblings = await many(db, `select id, kind, title, status from app.work_items where booking_id = $1 and id <> $2 and status <> 'done'`, [w.booking_id, w.id])
      await trace(db, s.at, 'assistant', 'model', 'Tool readWorkContext', {
        workItemId: w.id, bookingVersion: b.version, guests: b.guests, total: money(b.total_cents),
        sources: sources.map(x => `${x.id} (${x.link}, ${x.audience})`), authorisation: auth ? `${auth.max_pct}% by ${auth.name}` : null,
      })
      return {
        workItem: { id: w.id, kind: w.kind, title: w.title, status: w.status },
        booking: { id: b.id, title: b.title, eventDate: String(b.event_date), guests: b.guests, pricePerGuest: money(b.price_per_guest_cents), totalBeforeDiscount: money(b.guests * b.price_per_guest_cents), version: b.version },
        sources: sources.map(x => ({ id: x.id, link: x.link, audience: x.audience, channel: x.channel, author: x.author_ref, authorKind: x.author_kind, text: x.body })),
        origin: origin ? { conversation: origin.conversation, subject: origin.subject, participants } : null,
        authorisation: auth ? { maxPct: Number(auth.max_pct), scope: auth.scope, by: auth.name } : null,
        latestProposal: latest ?? null,
        otherOpenWork: siblings,
      }
    },
  })

  const recordWaiting = createTool({
    id: 'recordWaiting',
    description: 'Record what this request is waiting for, so it can resume later from durable state.',
    inputSchema: z.object({ workItemId: z.string(), waitingFor: z.enum(['manager_decision', 'booking_update', 'customer_reply']), note: z.string() }),
    execute: async (input, ctx) => {
      const s = scope(ctx)
      if (input.workItemId !== s.workItemId) return outOfScope(input.workItemId, s.workItemId)
      await db.query(`update app.work_items set status = 'waiting', waiting_for = $2, updated_at = $3 where id = $1`, [s.workItemId, input.waitingFor, s.at])
      await trace(db, s.at, 'assistant', 'state', `${s.workItemId} waiting for ${input.waitingFor.replace('_', ' ')}`, { workItemId: s.workItemId, note: input.note })
      return { status: 'recorded' }
    },
  })

  const closeWork = createTool({
    id: 'closeWork',
    description: 'Close this request when nothing is left to prepare.',
    inputSchema: z.object({ workItemId: z.string(), outcome: z.string() }),
    execute: async (input, ctx) => {
      const s = scope(ctx)
      if (input.workItemId !== s.workItemId) return outOfScope(input.workItemId, s.workItemId)
      await db.query(`update app.work_items set status = 'done', waiting_for = null, updated_at = $2 where id = $1`, [s.workItemId, s.at])
      await trace(db, s.at, 'assistant', 'state', `${s.workItemId} closed`, { workItemId: s.workItemId, outcome: input.outcome })
      return { status: 'closed' }
    },
  })

  const draftProposalTool = createTool({
    id: 'draftProposal',
    description: 'Prepare a discount change and the customer reply as one proposal. The application records the booking version it read.',
    inputSchema: z.object({ workItemId: z.string(), discountPct: z.number(), to: z.array(z.string()), subject: z.string(), body: z.string() }),
    execute: async (input, ctx) => {
      const s = scope(ctx)
      if (input.workItemId !== s.workItemId) return outOfScope(input.workItemId, s.workItemId)
      return draftProposal(db, input, s.at)
    },
  })

  const submitProposal = createTool({
    id: 'submitProposal',
    description: 'Ask a person to approve a drafted proposal. Runs only after approval.',
    inputSchema: z.object({ proposalId: z.string() }),
    requireApproval: true,
    beforeApproval: async (input, ctx) => {
      let s: { workItemId: string; at: Date; runId?: string }
      try { s = scope(ctx) } catch { return { proceed: false as const, output: { status: 'rejected_before_approval', reason: 'no worker scope', proposalId: input.proposalId } } }
      const reason = await checkBeforeApproval(db, input.proposalId, s.workItemId, s.at)
      if (reason) return { proceed: false as const, output: { status: 'rejected_before_approval', reason, proposalId: input.proposalId } }
    },
    execute: async (input, ctx) => {
      const s = scope(ctx)
      return executeProposal(db, input.proposalId, { workItemId: s.workItemId, runId: s.runId, at: s.at })
    },
  })

  return { readWorkContext, recordWaiting, closeWork, draftProposal: draftProposalTool, submitProposal }
}
