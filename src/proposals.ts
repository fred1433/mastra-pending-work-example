import crypto from 'node:crypto'
import type { Db, Tx } from './db.ts'
import { tx, one, many } from './db.ts'
import { trace, money } from './trace.ts'
import { sharedPhrase } from './intake.ts'
import { changeBooking } from './bookings.ts'

// jsonb reorders keys, so hash a canonical form.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as any)[k])]))
  return v
}

export function contentHash(p: { work_item_id: string; revision: number; based_on_booking_version: number; effects: unknown; reply_to: string[]; reply_subject: string; reply_body: string }) {
  const text = JSON.stringify(canonical([p.work_item_id, Number(p.revision), Number(p.based_on_booking_version), p.effects, [...p.reply_to].sort(), p.reply_subject, p.reply_body]))
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export type DraftInput = { workItemId: string; discountPct: number; to: string[]; subject: string; body: string }

/**
 * Builds a new proposal revision. The booking version is read here by the application;
 * the model never supplies it. Recipients, amount and audience are checked before anything is stored.
 */
export async function draftProposal(db: Db, d: DraftInput, at: Date) {
  return tx(db, async c => {
    const w = await one(c, 'select * from app.work_items where id = $1 for update', [d.workItemId])
    const b = await one(c, 'select * from app.bookings where id = $1', [w.booking_id])
    const auth = await one(c, `select a.*, s.name as granted_by_name from app.discount_authorizations a join app.staff s on s.id = a.granted_by
                               where a.work_item_id = $1 and not a.revoked order by a.id desc limit 1`, [w.id])
    const reject = async (reason: string) => {
      await trace(c, at, 'app', 'refusal', 'Draft rejected by the application', { workItemId: w.id, reason })
      return { status: 'rejected' as const, reason }
    }
    if (!auth) return reject('no manager authorisation is linked to this request')
    if (d.discountPct > Number(auth.max_pct)) return reject(`${d.discountPct}% exceeds the authorised ${auth.max_pct}%`)

    const allowed = await many(c,
      `select distinct p.address from app.work_sources s join app.messages m on m.id = s.message_id
       join app.conversations cv on cv.id = m.conversation_id join app.participants p on p.conversation_id = cv.id
       where s.work_item_id = $1 and cv.audience = 'external' and s.link in ('origin','evidence')`, [w.id])
    const bad = d.to.filter(t => !allowed.some(a => a.address === t))
    if (!d.to.length || bad.length) return reject(`recipient not in this request’s external threads: ${bad.join(', ') || '(none)'}`)

    const internal = await many(c,
      `select m.id, m.body from app.messages m join app.conversations cv on cv.id = m.conversation_id
       where cv.booking_id = $1 and cv.audience = 'internal'`, [w.booking_id])
    for (const n of internal) {
      const leak = sharedPhrase(d.body, n.body)
      if (leak) return reject(`reply repeats internal note ${n.id} (“${leak}”)`)
    }

    const before = b.guests * b.price_per_guest_cents
    const after = Math.round(before * (1 - d.discountPct / 100))
    if (!d.body.includes(money(after))) return reject(`reply does not state the computed total ${money(after)}`)

    const prev = await one(c, 'select coalesce(max(revision),0)::int as r from app.proposals where work_item_id = $1', [w.id])
    const revision = prev.r + 1
    await c.query(`update app.proposals set status = 'superseded', status_reason = $2, updated_at = $3
                   where work_item_id = $1 and status in ('draft','pending_approval')`, [w.id, `replaced by r${revision}`, at])
    const evidence = (await many(c, 'select message_id from app.work_sources where work_item_id = $1 and link <> $2 order by message_id', [w.id, 'suggested'])).map(r => r.message_id)
    const row = {
      id: `${w.id}-r${revision}`, work_item_id: w.id, revision, booking_id: b.id, based_on_booking_version: b.version,
      effects: { discountPct: d.discountPct, guests: b.guests, totalBeforeCents: before, totalAfterCents: after, authorisationId: Number(auth.id) },
      reply_to: d.to, reply_subject: d.subject, reply_body: d.body,
    }
    const hash = contentHash(row)
    await c.query(
      `insert into app.proposals (id, work_item_id, revision, booking_id, based_on_booking_version, effects, reply_to, reply_subject, reply_body, evidence, content_hash, status, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$12)`,
      [row.id, w.id, revision, b.id, b.version, JSON.stringify(row.effects), d.to, d.subject, d.body, evidence, hash, at])
    await c.query(`update app.work_items set status = 'drafting', waiting_for = null, updated_at = $2 where id = $1`, [w.id, at])
    await trace(c, at, 'app', 'state', `Proposal ${row.id} drafted`, {
      proposalId: row.id, basedOnBookingVersion: b.version, discount: `${d.discountPct}%`, total: `${money(before)} → ${money(after)}`,
      to: d.to, evidence, hash, authorisedBy: auth.granted_by_name,
    })
    return { status: 'drafted' as const, proposalId: row.id, revision, basedOnBookingVersion: b.version, totalAfter: money(after) }
  })
}

/** beforeApproval: refuse to show a person a proposal that is already unusable. Not re-run on resume. */
export async function checkBeforeApproval(db: Db, proposalId: string, workItemId: string, at: Date) {
  const p = await one(db, 'select p.*, b.version as booking_version from app.proposals p join app.bookings b on b.id = p.booking_id where p.id = $1', [proposalId])
  let reason: string | null = null
  if (!p) reason = 'unknown proposal'
  else if (p.work_item_id !== workItemId) reason = 'proposal belongs to another request'
  else if (p.status !== 'draft') reason = `proposal is ${p.status}`
  else if (p.booking_version !== p.based_on_booking_version) reason = `booking moved to v${p.booking_version}`
  if (reason) await trace(db, at, 'app', 'refusal', 'beforeApproval: not shown to a person', { proposalId, reason })
  return reason
}

export async function markPendingApproval(db: Db, proposalId: string, runId: string, toolCallId: string, at: Date) {
  return tx(db, async c => {
    const r = await one(c,
      `update app.proposals set status = 'pending_approval', mastra_run_id = $2, mastra_tool_call_id = $3, updated_at = $4
       where id = $1 and status = 'draft' returning *`, [proposalId, runId, toolCallId, at])
    if (r) {
      await c.query(`update app.work_items set status = 'waiting_approval', waiting_for = 'approval of ' || $2, updated_at = $3 where id = $1`, [r.work_item_id, proposalId, at])
      await trace(c, at, 'mastra', 'gate', `Suspended for approval of ${proposalId}`, { proposalId, runId, toolCallId, note: 'requireApproval: Mastra persists the suspended run in Postgres' })
    } else {
      await c.query('update app.proposals set mastra_run_id = $2, mastra_tool_call_id = $3 where id = $1', [proposalId, runId, toolCallId])
    }
    return !!r
  })
}

/**
 * Human approval of one exact revision. Atomic conditional transition: a double click,
 * or two people at once, get the same approval back. An invalidated proposal cannot be approved.
 */
export async function approveProposal(db: Db, a: { proposalId: string; contentHash: string; staffId: string; at: Date }) {
  return tx(db, async c => {
    const staff = await one(c, 'select * from app.staff where id = $1', [a.staffId])
    const p = await one(c,
      `update app.proposals set status = 'approved', updated_at = $3
       where id = $1 and status = 'pending_approval' and content_hash = $2 returning *`, [a.proposalId, a.contentHash, a.at])
    if (p) {
      const ap = await one(c, `insert into app.approvals (proposal_id, content_hash, approved_by, approved_at) values ($1,$2,$3,$4) returning id`,
        [p.id, p.content_hash, staff.id, a.at])
      await trace(c, a.at, staff.name, 'gate', `${p.id} approved`, { proposalId: p.id, approvalId: Number(ap.id), hash: p.content_hash })
      return { outcome: 'approved' as const, approvalId: Number(ap.id) }
    }
    const cur = await one(c, 'select p.*, a.id as approval_id from app.proposals p left join app.approvals a on a.proposal_id = p.id where p.id = $1', [a.proposalId])
    if (cur && cur.approval_id && cur.content_hash === a.contentHash) {
      await trace(c, a.at, staff.name, 'state', 'Second click: existing approval returned', { proposalId: cur.id, approvalId: Number(cur.approval_id) })
      return { outcome: 'already_approved' as const, approvalId: Number(cur.approval_id) }
    }
    const reason = !cur ? 'unknown proposal' : cur.content_hash !== a.contentHash ? 'the proposal changed since it was displayed' : `${cur.id} is ${cur.status}${cur.status_reason ? ` (${cur.status_reason})` : ''}`
    await trace(c, a.at, staff.name, 'refusal', 'Approval refused', { proposalId: a.proposalId, reason })
    return { outcome: 'refused' as const, reason }
  })
}

export const actionKeyFor = (proposalId: string) => `send-reply:${proposalId}`

/**
 * Runs inside the tool's execute, after Mastra resumes. Rechecks everything, then in ONE transaction:
 * consumes the approval, applies the booking change and records the intent to send.
 */
export async function executeProposal(db: Db, proposalId: string, ctx: { workItemId: string; runId?: string; at: Date }) {
  return tx(db, async c => {
    const p = await one(c, 'select * from app.proposals where id = $1 for update', [proposalId])
    if (!p || p.work_item_id !== ctx.workItemId) return { status: 'refused' as const, reason: 'proposal outside this request' }
    const b = await one(c, 'select * from app.bookings where id = $1 for update', [p.booking_id])
    const key = actionKeyFor(p.id)
    const refuse = async (status: 'stale' | 'not_approved' | 'content_changed' | 'unauthorised', reason: string) => {
      if (['draft', 'pending_approval', 'approved'].includes(p.status) && status !== 'not_approved') {
        await c.query(`update app.proposals set status = 'invalidated', status_reason = $2, updated_at = $3 where id = $1`, [p.id, reason, ctx.at])
      }
      await trace(c, ctx.at, 'app', 'refusal', 'Execution refused in execute()', { proposalId: p.id, reason, runId: ctx.runId })
      return { status, reason, proposalId: p.id }
    }
    if (p.status === 'executed') {
      await trace(c, ctx.at, 'app', 'state', 'Already executed: same action returned', { proposalId: p.id, actionKey: key, runId: ctx.runId })
      return { status: 'already_executed' as const, actionKey: key }
    }
    if (b.version !== p.based_on_booking_version) return refuse('stale', `booking is v${b.version}, proposal was built on v${p.based_on_booking_version}`)
    if (p.status !== 'approved') return refuse('not_approved', `proposal is ${p.status}${p.status_reason ? ` (${p.status_reason})` : ''}`)
    if (contentHash(p) !== p.content_hash) return refuse('content_changed', 'proposal content no longer matches what was approved')
    // Every check before the approval is consumed: a refusal leaves the approval untouched.
    const auth = await one(c, 'select * from app.discount_authorizations where id = $1 and not revoked', [p.effects.authorisationId])
    if (!auth || Number(auth.max_pct) < p.effects.discountPct) return refuse('unauthorised', 'manager authorisation revoked or narrowed')
    const ap = await one(c,
      `update app.approvals set consumed_at = $2, consumed_by_action = $3
       where proposal_id = $1 and consumed_at is null and content_hash = $4 returning *`, [p.id, ctx.at, key, p.content_hash])
    if (!ap) return refuse('content_changed', 'no unconsumed approval for this exact content')

    await c.query(`update app.proposals set status = 'executed', updated_at = $2 where id = $1`, [p.id, ctx.at])
    await c.query(`update app.work_items set status = 'sending', waiting_for = null, updated_at = $2 where id = $1`, [p.work_item_id, ctx.at])
    await trace(c, ctx.at, 'app', 'effect', 'Approval consumed', { proposalId: p.id, approvalId: Number(ap.id), actionKey: key, runId: ctx.runId })
    await changeBooking(c, b.id, { discountPct: p.effects.discountPct },
      { provenance: 'assistant', actor: 'assistant', actionKey: key, workItemId: p.work_item_id }, ctx.at)
    const ins = await c.query(
      `insert into app.actions (key, proposal_id, kind, payload, status, created_at, updated_at)
       values ($1,$2,'send_email',$3,'pending',$4,$4) on conflict (key) do nothing`,
      [key, p.id, JSON.stringify({ to: p.reply_to, subject: p.reply_subject, body: p.reply_body, conversationId: null }), ctx.at])
    await trace(c, ctx.at, 'app', 'effect', 'Intent to send recorded (same transaction)', { actionKey: key, created: ins.rowCount === 1 })
    return { status: 'executed' as const, actionKey: key }
  })
}
