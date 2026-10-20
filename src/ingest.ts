// Entry points a Next.js route handler would call. Each one records the input durably, applies the
// wake-up policy in the same transaction, and returns. The Mastra worker consumes the wake-ups.
import type { Db, Tx } from './db.ts'
import { tx, one, many } from './db.ts'
import { trace } from './trace.ts'
import { wakeNow } from './wake.ts'
import { changeBooking, lockBooking, staffInOrg, type BookingPatch } from './bookings.ts'
import { classifyRequest } from './intake.ts'
import type { Pause } from './hooks.ts'

let seq = 0
const nextId = (p: string) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`

/**
 * Inbound email. The sender comes from the mail headers, not from what the text claims.
 * Find-or-create is atomic: the conversation row is locked first, and a unique index allows one open work
 * item per (conversation, request key). `requestKey` is set when intake or staff mark a separate request.
 */
export async function receiveEmail(db: Db, m: { conversationId: string; externalId: string; from: string; body: string; at: Date; requestKey?: string; pause?: Pause }) {
  const requestKey = m.requestKey ?? 'main'
  return tx(db, async c => {
    const conv = await one(c, 'select * from app.conversations where id = $1 for update', [m.conversationId])
    const ins = await c.query(
      `insert into app.messages (id, conversation_id, external_id, author_kind, author_ref, body, at)
       values ($1,$2,$3,'customer',$4,$5,$6) on conflict (external_id) do nothing returning id`,
      [`MSG-${m.externalId}`, conv.id, m.externalId, m.from, m.body, m.at])
    if (!ins.rowCount) {
      await trace(c, m.at, 'app', 'state', 'Duplicate delivery ignored', { externalId: m.externalId })
      return { messageId: `MSG-${m.externalId}`, duplicate: true }
    }
    const messageId = ins.rows[0].id
    await c.query(`insert into app.events (org_id, booking_id, kind, provenance, actor, payload, at)
                   values ($1,$2,'email_received','customer',$3,$4,$5)`,
      [conv.org_id, conv.booking_id, m.from, JSON.stringify({ messageId, conversationId: conv.id }), m.at])
    await trace(c, m.at, m.from, 'input', `Email in ${conv.id}`, { conversation: conv.id, subject: conv.subject, from: m.from, body: m.body, audience: conv.audience })

    const existing = await one(c,
      `select * from app.work_items where origin_conversation_id = $1 and request_key = $2 and status <> 'done'`, [conv.id, requestKey])
    await m.pause?.('after-lookup')
    if (existing) {
      await linkSource(c, existing.id, messageId, 'evidence', 'app', 'same email thread as the request', m.at)
      await wakeNow(c, existing.id, 'new message on the request thread', m.at)
      return { messageId, workItemId: existing.id, created: false }
    }
    const kind = classifyRequest(conv.subject, m.body)
    // A sequence, not count(*)+1: two emails arriving together must not compete for the same id.
    const workItemId: string = (await one(c, `select 'W' || nextval('app.work_item_seq') as id`)).id
    await c.query(
      `insert into app.work_items (id, org_id, booking_id, kind, title, status, mastra_resource, mastra_thread, origin_conversation_id, request_key, created_at, updated_at)
       values ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$10)`,
      [workItemId, conv.org_id, conv.booking_id, kind, conv.subject, `${conv.org_id}:booking:${conv.booking_id}`, `work:${workItemId}`, conv.id, requestKey, m.at])
    await trace(c, m.at, 'app', 'state', 'Work item opened', {
      workItemId, kind, booking: conv.booking_id,
      mastraResource: `${conv.org_id}:booking:${conv.booking_id}`, mastraThread: `work:${workItemId}`,
    })
    await linkSource(c, workItemId, messageId, 'origin', 'app', 'first message of the request', m.at)
    await wakeNow(c, workItemId, 'new request', m.at)
    return { messageId, workItemId, created: true }
  })
}

export async function linkSource(c: Tx, workItemId: string, messageId: string, link: string, by: string, reason: string, at: Date) {
  await c.query(
    `insert into app.work_sources (work_item_id, message_id, link, linked_by, reason) values ($1,$2,$3,$4,$5)
     on conflict (work_item_id, message_id) do update set link = excluded.link, linked_by = excluded.linked_by, reason = excluded.reason`,
    [workItemId, messageId, link, by, reason])
  await trace(c, at, by, 'link', `Source linked as ${link}`, { workItemId, messageId, reason })
}

export type NoteOutcome =
  | { outcome: 'decision'; workItemId: string; authorizationId: number }
  | { outcome: 'linked_without_authority'; workItemId: string; reason: string }
  | { outcome: 'declined'; workItemId: string; revoked: number }
  | { outcome: 'suggested'; workItemId: string; clarificationId: number; evidence: string[] }
  | { outcome: 'needs_clarification'; clarificationId: number; candidates: string[] }

/** What a manager records with the note box controls (approve or decline, and the amount). */
export type NoteDecision = { approve: boolean; maxPct?: number }

/**
 * Internal note. `staffId` comes from the authenticated session. `refWorkItemId` is set when the note is
 * written from a request's note box, which gives an explicit, deterministic link. `decision` comes from the
 * box's controls. The note's text is evidence only: no amount or authority is ever read from it.
 */
export async function addInternalNote(db: Db, n: { bookingId: string; staffId: string; body: string; refWorkItemId?: string; decision?: NoteDecision; at: Date }) {
  return tx(db, async c => {
    const b = await lockBooking(c, n.bookingId)
    const staff = await staffInOrg(c, n.staffId, b.org_id)
    const conv = await one(c, `select * from app.conversations where booking_id = $1 and channel = 'note'`, [n.bookingId])
    const messageId = nextId('NOTE')
    await c.query(`insert into app.messages (id, conversation_id, author_kind, author_ref, body, at) values ($1,$2,'staff',$3,$4,$5)`,
      [messageId, conv.id, staff.id, n.body, n.at])
    await c.query(`insert into app.events (org_id, booking_id, kind, provenance, actor, payload, at) values ($1,$2,'note_added','staff',$3,$4,$5)`,
      [staff.org_id, n.bookingId, staff.id, JSON.stringify({ messageId }), n.at])
    await trace(c, n.at, staff.name, 'input', 'Internal note', {
      messageId, author: `${staff.name} (${staff.role}, from session)`, body: n.body, audience: 'internal', explicitReference: n.refWorkItemId ?? null,
      decision: n.decision ? (n.decision.approve ? `approve up to ${n.decision.maxPct}%` : 'decline') : null,
    })
    const out = await attachNote(c, { messageId, staff, bookingId: n.bookingId, body: n.body, refWorkItemId: n.refWorkItemId, decision: n.decision, at: n.at })
    return { messageId, ...out }
  })
}

function validPct(d: NoteDecision) {
  if (d.maxPct === undefined || !Number.isFinite(d.maxPct) || d.maxPct <= 0 || d.maxPct > 100) throw new Error('an approval needs a percentage between 0 and 100')
  return d.maxPct
}

/**
 * A new decision replaces the previous one: earlier authorisations are revoked and every proposal built on
 * them is invalidated, in the caller's transaction (which holds the booking lock).
 */
async function replaceDecision(c: Tx, w: any, at: Date, waitingFor: string) {
  const revoked = await c.query(`update app.discount_authorizations set revoked = true where work_item_id = $1 and not revoked`, [w.id])
  const inv = await many(c,
    `update app.proposals set status = 'invalidated', status_reason = 'manager decision changed', updated_at = $2
     where work_item_id = $1 and status in ('draft','pending_approval','approved') returning id`, [w.id, at])
  for (const p of inv) await trace(c, at, 'app', 'refusal', 'Proposal invalidated at once', { proposalId: p.id, workItemId: w.id, reason: 'manager decision changed' })
  if (inv.length || waitingFor === 'manager_decision') {
    await c.query(`update app.work_items set status = 'waiting', waiting_for = $2, updated_at = $3 where id = $1`, [w.id, waitingFor, at])
  }
  return revoked.rowCount ?? 0
}

async function authorise(c: Tx, w: any, pct: number, grantedBy: any, messageId: string, at: Date) {
  await replaceDecision(c, w, at, 'redraft')
  const scope = `up to ${pct}% on this booking’s total, for request ${w.id} only`
  const a = await one(c,
    `insert into app.discount_authorizations (work_item_id, booking_id, max_pct, scope, granted_by, source_message_id, at)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`, [w.id, w.booking_id, pct, scope, grantedBy.id, messageId, at])
  await trace(c, at, 'app', 'gate', 'Manager authorisation recorded', { workItemId: w.id, maxPct: pct, grantedBy: grantedBy.name, scope })
  await wakeNow(c, w.id, 'manager decision linked', at)
  return Number(a.id)
}

async function decline(c: Tx, w: any, staff: any, at: Date) {
  const revoked = await replaceDecision(c, w, at, 'manager_decision')
  await trace(c, at, 'app', 'refusal', 'Manager declined: nothing authorised', { workItemId: w.id, by: staff.name, revokedEarlier: revoked })
  await wakeNow(c, w.id, 'manager declined', at)
  return revoked
}

async function attachNote(c: Tx, n: { messageId: string; staff: any; bookingId: string; body: string; refWorkItemId?: string; decision?: NoteDecision; at: Date }): Promise<NoteOutcome> {
  const open = await many(c, `select * from app.work_items where booking_id = $1 and status <> 'done' order by id`, [n.bookingId])

  // 1. Explicit reference from the interface: deterministic.
  if (n.refWorkItemId) {
    const w = open.find(o => o.id === n.refWorkItemId)
    if (!w) throw new Error(`work item ${n.refWorkItemId} is not open on booking ${n.bookingId}`)
    const reason = n.staff.role !== 'manager' ? `${n.staff.name} is ${n.staff.role}`
      : w.kind !== 'discount' ? 'this request is not a discount'
      : !n.decision ? 'no decision recorded with the note box controls' : null
    if (reason) {
      await linkSource(c, w.id, n.messageId, 'evidence', 'app', `explicit reference; ${reason}`, n.at)
      await trace(c, n.at, 'app', 'refusal', 'Note linked, no authorisation', { workItemId: w.id, reason })
      return { outcome: 'linked_without_authority', workItemId: w.id, reason }
    }
    await linkSource(c, w.id, n.messageId, 'decision', 'app', 'explicit reference from the note box', n.at)
    if (!n.decision!.approve) return { outcome: 'declined', workItemId: w.id, revoked: await decline(c, w, n.staff, n.at) }
    return { outcome: 'decision', workItemId: w.id, authorizationId: await authorise(c, w, validPct(n.decision!), n.staff, n.messageId, n.at) }
  }

  // 2. Free reference: propose a match with its evidence. A suggestion never authorises anything.
  const text = n.body.toLowerCase()
  const scored: { w: any; evidence: string[] }[] = []
  for (const w of open) {
    const evidence: string[] = []
    const origin = await one(c,
      `select m.author_ref from app.work_sources s join app.messages m on m.id = s.message_id where s.work_item_id = $1 and s.link = 'origin'`, [w.id])
    const firstName = origin?.author_ref?.split('@')[0]
    if (firstName && text.includes(firstName.toLowerCase())) evidence.push(`names the requester (${firstName})`)
    if (w.title && text.includes(w.title.toLowerCase().split(' ').slice(0, 2).join(' '))) evidence.push('quotes the request subject')
    if (evidence.length) scored.push({ w, evidence })
  }
  if (scored.length === 1) {
    const { w, evidence } = scored[0]
    await linkSource(c, w.id, n.messageId, 'suggested', 'matcher', evidence.join('; '), n.at)
    const cl = await one(c, `insert into app.clarifications (message_id, candidates, question, at) values ($1,$2,$3,$4) returning id`,
      [n.messageId, [w.id], `Does this note decide request ${w.id} (${w.title})?`, n.at])
    await trace(c, n.at, 'app', 'refusal', 'Match suggested, not an authorisation', { workItemId: w.id, evidence, clarificationId: Number(cl.id) })
    return { outcome: 'suggested', workItemId: w.id, clarificationId: Number(cl.id), evidence }
  }

  // 3. Ambiguous: ask, approve nothing.
  const candidates = open.map(o => o.id)
  const cl = await one(c, `insert into app.clarifications (message_id, candidates, question, at) values ($1,$2,$3,$4) returning id`,
    [n.messageId, candidates, `Which request does this note answer: ${open.map(o => `${o.id} (${o.title})`).join(' or ')}?`, n.at])
  await trace(c, n.at, 'app', 'refusal', 'Ambiguous note: clarification asked, nothing approved', { candidates, clarificationId: Number(cl.id) })
  return { outcome: 'needs_clarification', clarificationId: Number(cl.id), candidates }
}

/** A manager confirms a suggested or ambiguous note from the interface, with a structured decision. Only then can it authorise. */
export async function confirmNoteLink(db: Db, a: { clarificationId: number; workItemId: string; staffId: string; decision: NoteDecision; at: Date }) {
  return tx(db, async c => {
    const wi = await one(c, 'select booking_id from app.work_items where id = $1', [a.workItemId])
    const b = await lockBooking(c, wi.booking_id)
    const staff = await staffInOrg(c, a.staffId, b.org_id)
    const cl = await one(c, `update app.clarifications set status = 'answered' where id = $1 and status = 'open' and $2 = any(candidates) returning *`, [a.clarificationId, a.workItemId])
    if (!cl) return { outcome: 'refused' as const }
    const w = await one(c, 'select * from app.work_items where id = $1', [a.workItemId])
    if (staff.role !== 'manager' || w.kind !== 'discount') {
      await linkSource(c, w.id, cl.message_id, 'evidence', staff.name, 'confirmed in the interface, without authority', a.at)
      return { outcome: 'linked_without_authority' as const }
    }
    await linkSource(c, w.id, cl.message_id, 'decision', staff.name, 'confirmed in the interface', a.at)
    if (!a.decision.approve) { await decline(c, w, staff, a.at); return { outcome: 'declined' as const } }
    await authorise(c, w, validPct(a.decision), staff, cl.message_id, a.at)
    return { outcome: 'decision' as const }
  })
}

export async function staffEditsBooking(db: Db, e: { bookingId: string; staffId: string; patch: BookingPatch; at: Date }) {
  return tx(db, async c => {
    const b = await lockBooking(c, e.bookingId)
    const staff = await staffInOrg(c, e.staffId, b.org_id)
    return changeBooking(c, e.bookingId, e.patch, { provenance: 'staff', actor: staff.name }, e.at)
  })
}

/** Contact details are not a dependency of any proposal here: no version bump, no wake-up. */
export async function staffEditsContact(db: Db, e: { contactId: string; staffId: string; phone: string; at: Date }) {
  return tx(db, async c => {
    const before = await one(c, 'select org_id from app.contacts where id = $1', [e.contactId])
    const staff = await staffInOrg(c, e.staffId, before.org_id)
    const ct = await one(c, 'update app.contacts set phone = $2 where id = $1 returning *', [e.contactId, e.phone])
    await c.query(`insert into app.events (org_id, booking_id, kind, provenance, actor, payload, at) values ($1,$2,'contact_changed','staff',$3,$4,$5)`,
      [ct.org_id, ct.booking_id, staff.name, JSON.stringify({ contactId: ct.id, changed: ['phone'] }), e.at])
    await trace(c, e.at, staff.name, 'input', 'Contact phone edited in the CRM', { contactId: ct.id })
    await trace(c, e.at, 'worker', 'state', 'No wake-up: contact fields are not a dependency of any open work', { contactId: ct.id })
  })
}

export async function setDeadline(db: Db, workItemId: string, resumeAt: Date, at: Date) {
  await db.query('update app.work_items set resume_at = $2, updated_at = $3 where id = $1', [workItemId, resumeAt, at])
  await trace(db, at, 'app', 'state', 'Deadline set', { workItemId, resumeAt })
}
