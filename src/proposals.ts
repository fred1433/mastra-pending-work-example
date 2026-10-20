import crypto from 'node:crypto'
import type { Db, Tx } from './db.ts'
import { tx, one, many } from './db.ts'
import { trace, money } from './trace.ts'
import { sharedPhrase } from './intake.ts'
import { changeBooking, lockBooking, staffInOrg } from './bookings.ts'
import type { Pause } from './hooks.ts'

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
 * Builds a new proposal revision, tied to the context read the model wrote it from (app.context_reads,
 * recorded by readWorkContext). If the booking or the manager's decision moved since that read, the draft
 * is refused and the model has to read again. Recipients, amount and audience are checked before storing.
 * The new revision becomes the only active one: older drafts, pending and approved revisions are superseded.
 */
export async function draftProposal(db: Db, d: DraftInput, at: Date) {
  return tx(db, async c => {
    const wi = await one(c, 'select booking_id from app.work_items where id = $1', [d.workItemId])
    const b = await lockBooking(c, wi.booking_id)
    const w = await one(c, 'select * from app.work_items where id = $1 for update', [d.workItemId])
    const auth = await one(c, `select a.*, s.name as granted_by_name from app.discount_authorizations a join app.staff s on s.id = a.granted_by
                               where a.work_item_id = $1 and not a.revoked order by a.id desc limit 1`, [w.id])
    const read = await one(c, 'select * from app.context_reads where work_item_id = $1 order by id desc limit 1', [w.id])
    const reject = async (reason: string) => {
      await trace(c, at, 'app', 'refusal', 'Draft rejected by the application', { workItemId: w.id, reason })
      return { status: 'rejected' as const, reason }
    }
    if (!read) return reject('read the request’s context first')
    if (read.booking_version !== b.version) return reject(`the booking changed since it was read (v${read.booking_version} → v${b.version}); read it again`)
    if (String(read.authorisation_id ?? '') !== String(auth?.id ?? '')) return reject('the manager’s decision changed since it was read; read it again')
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
    // Everything that leaves: subject and body. The check is five consecutive words shared with a note.
    for (const n of internal) {
      const leak = sharedPhrase(`${d.subject}\n${d.body}`, n.body)
      if (leak) return reject(`reply repeats internal note ${n.id} (“${leak}”)`)
    }

    const before = b.guests * b.price_per_guest_cents
    const after = Math.round(before * (1 - d.discountPct / 100))
    if (!d.body.includes(money(after))) return reject(`reply does not state the computed total ${money(after)}`)

    const prev = await one(c, 'select coalesce(max(revision),0)::int as r from app.proposals where work_item_id = $1', [w.id])
    const revision = prev.r + 1
    await c.query(`update app.proposals set status = 'superseded', status_reason = $2, updated_at = $3
                   where work_item_id = $1 and status in ('draft','pending_approval','approved')`, [w.id, `replaced by r${revision}`, at])
    // Wake-ups for events this read already covered are done: no second redraft later.
    await c.query(`delete from app.wakeups where work_item_id = $1 and claimed_by is null and last_event_at <= $2`, [w.id, read.at])
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
  else if (p.revision !== Number((await one(db, 'select max(revision) as r from app.proposals where work_item_id = $1', [p.work_item_id])).r)) reason = 'a newer revision exists'
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
    const pre = await one(c, 'select booking_id from app.proposals where id = $1', [a.proposalId])
    if (!pre) return { outcome: 'refused' as const, reason: 'unknown proposal' }
    const b = await lockBooking(c, pre.booking_id)
    let staff: any
    try { staff = await staffInOrg(c, a.staffId, b.org_id) } catch (e: any) {
      await trace(c, a.at, 'app', 'refusal', 'Approval refused', { proposalId: a.proposalId, reason: e.message })
      return { outcome: 'refused' as const, reason: e.message as string }
    }
    const p = await one(c,
      `update app.proposals p set status = 'approved', updated_at = $3
       where id = $1 and status = 'pending_approval' and content_hash = $2
         and revision = (select max(revision) from app.proposals where work_item_id = p.work_item_id) returning *`, [a.proposalId, a.contentHash, a.at])
    if (p) {
      const ap = await one(c, `insert into app.approvals (proposal_id, content_hash, approved_by, approved_at) values ($1,$2,$3,$4) returning id`,
        [p.id, p.content_hash, staff.id, a.at])
      await trace(c, a.at, staff.name, 'gate', `${p.id} approved`, { proposalId: p.id, approvalId: Number(ap.id), hash: p.content_hash })
      return { outcome: 'approved' as const, approvalId: Number(ap.id) }
    }
    const cur = await one(c, 'select p.*, a.id as approval_id from app.proposals p left join app.approvals a on a.proposal_id = p.id where p.id = $1', [a.proposalId])
    if (cur && cur.approval_id && cur.content_hash === a.contentHash && cur.status === 'approved') {
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
export async function executeProposal(db: Db, proposalId: string, ctx: { workItemId: string; runId?: string; at: Date; pause?: Pause }) {
  return tx(db, async c => {
    const pre = await one(c, 'select booking_id from app.proposals where id = $1', [proposalId])
    if (!pre) return { status: 'refused' as const, reason: 'unknown proposal' }
    const b = await lockBooking(c, pre.booking_id)
    await ctx.pause?.('first-lock')
    const p = await one(c, 'select * from app.proposals where id = $1 for update', [proposalId])
    if (p.work_item_id !== ctx.workItemId) return { status: 'refused' as const, reason: 'proposal outside this request' }
    const key = actionKeyFor(p.id)
    const active = Number((await one(c, 'select max(revision) as r from app.proposals where work_item_id = $1', [p.work_item_id])).r)
    const refuse = async (status: 'stale' | 'not_approved' | 'content_changed' | 'unauthorised' | 'superseded', reason: string) => {
      if (['draft', 'pending_approval', 'approved'].includes(p.status) && status !== 'not_approved' && status !== 'superseded') {
        await c.query(`update app.proposals set status = 'invalidated', status_reason = $2, updated_at = $3 where id = $1`, [p.id, reason, ctx.at])
      }
      // The work item never stays parked on a revision that can no longer run (unless a newer one governs it).
      if (status === 'unauthorised') await c.query(`update app.work_items set status = 'waiting', waiting_for = 'manager_decision', updated_at = $2 where id = $1`, [p.work_item_id, ctx.at])
      if (status === 'stale' || status === 'content_changed') await c.query(`update app.work_items set status = 'waiting', waiting_for = 'redraft', updated_at = $2 where id = $1`, [p.work_item_id, ctx.at])
      await trace(c, ctx.at, 'app', 'refusal', 'Execution refused in execute()', { proposalId: p.id, reason, runId: ctx.runId })
      return { status, reason, proposalId: p.id }
    }
    if (p.status === 'executed') {
      await trace(c, ctx.at, 'app', 'state', 'Already executed: same action returned', { proposalId: p.id, actionKey: key, runId: ctx.runId })
      return { status: 'already_executed' as const, actionKey: key }
    }
    if (b.version !== p.based_on_booking_version) return refuse('stale', `booking is v${b.version}, proposal was built on v${p.based_on_booking_version}`)
    if (p.revision !== active) return refuse('superseded', `a newer revision (r${active}) exists`)
    if (p.status !== 'approved') return refuse('not_approved', `proposal is ${p.status}${p.status_reason ? ` (${p.status_reason})` : ''}`)
    if (contentHash(p) !== p.content_hash) return refuse('content_changed', 'proposal content no longer matches what was approved')
    // Every check before the approval is consumed: a refusal leaves the approval untouched.
    // The authorisation is locked and must still be the current one; its granter and the approver must
    // still belong to the booking's organisation with the right role.
    const auth = await one(c, `select a.*, s.org_id, s.role from app.discount_authorizations a join app.staff s on s.id = a.granted_by
                               where a.id = $1 for update of a`, [p.effects.authorisationId])
    if (!auth || auth.revoked || Number(auth.max_pct) < p.effects.discountPct || auth.org_id !== b.org_id || auth.role !== 'manager') {
      return refuse('unauthorised', 'manager authorisation revoked, replaced or narrowed')
    }
    const approver = await one(c, `select s.* from app.approvals a join app.staff s on s.id = a.approved_by where a.proposal_id = $1`, [p.id])
    if (!approver || approver.org_id !== b.org_id || !['manager', 'coordinator'].includes(approver.role)) {
      return refuse('not_approved', 'the approver has no rights on this booking')
    }
    await ctx.pause?.('checked')
    const ap = await one(c,
      `update app.approvals set consumed_at = $2, consumed_by_action = $3
       where proposal_id = $1 and consumed_at is null and content_hash = $4 returning *`, [p.id, ctx.at, key, p.content_hash])
    if (!ap) return refuse('content_changed', 'no unconsumed approval for this exact content')

    await c.query(`update app.proposals set status = 'executed', updated_at = $2 where id = $1`, [p.id, ctx.at])
    await c.query(`update app.work_items set status = 'sending', waiting_for = null, updated_at = $2 where id = $1`, [p.work_item_id, ctx.at])
    await trace(c, ctx.at, 'app', 'effect', 'Approval consumed', { proposalId: p.id, approvalId: Number(ap.id), actionKey: key, runId: ctx.runId })
    await changeBooking(c, b.id, { discountPct: p.effects.discountPct },
      { provenance: 'assistant', actor: 'assistant', actionKey: key, workItemId: p.work_item_id }, ctx.at)
    await ctx.pause?.('before-outbox')
    const ins = await c.query(
      `insert into app.actions (key, proposal_id, kind, payload, status, created_at, updated_at)
       values ($1,$2,'send_email',$3,'pending',$4,$4) on conflict (key) do nothing`,
      [key, p.id, JSON.stringify({ to: p.reply_to, subject: p.reply_subject, body: p.reply_body, conversationId: null }), ctx.at])
    await trace(c, ctx.at, 'app', 'effect', 'Intent to send recorded (same transaction)', { actionKey: key, created: ins.rowCount === 1 })
    return { status: 'executed' as const, actionKey: key }
  })
}
