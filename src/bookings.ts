import type { Tx } from './db.ts'
import { one, many } from './db.ts'
import { trace, money } from './trace.ts'
import { wakeBatched } from './wake.ts'

export type BookingPatch = { guests?: number; title?: string; discountPct?: number }
export type ChangeSource =
  | { provenance: 'staff'; actor: string }
  | { provenance: 'assistant'; actor: string; actionKey: string; workItemId: string }

/**
 * The only way the booking changes. Bumps the single version (conservative prototype),
 * invalidates every proposal built on an older version in the same transaction,
 * then queues batched wake-ups.
 */
export async function changeBooking(c: Tx, bookingId: string, patch: BookingPatch, src: ChangeSource, at: Date) {
  const b = await one(c, 'select * from app.bookings where id = $1 for update', [bookingId])
  const guests = patch.guests ?? b.guests
  const discountPct = patch.discountPct ?? Number(b.discount_pct)
  const total = Math.round(guests * b.price_per_guest_cents * (1 - discountPct / 100))
  const changed = Object.keys(patch)
  const nb = await one(c,
    `update app.bookings set guests = $2, title = $3, discount_pct = $4, total_cents = $5, version = version + 1,
       last_change_provenance = $6, last_action_key = $7
     where id = $1 returning *`,
    [bookingId, guests, patch.title ?? b.title, discountPct, total, src.provenance, 'actionKey' in src ? src.actionKey : null])
  await c.query(
    `insert into app.events (org_id, booking_id, kind, provenance, actor, action_key, payload, at)
     values ($1,$2,'booking_changed',$3,$4,$5,$6,$7)`,
    [b.org_id, bookingId, src.provenance, src.actor, 'actionKey' in src ? src.actionKey : null,
     JSON.stringify({ changed, fromVersion: b.version, toVersion: nb.version }), at])
  await trace(c, at, src.actor, 'input', src.provenance === 'assistant' ? 'Booking updated by the assistant' : 'Booking edited in the CRM', {
    bookingId, changed, version: `${b.version} → ${nb.version}`, guests: `${b.guests} → ${guests}`,
    total: `${money(b.total_cents)} → ${money(total)}`, provenance: src.provenance,
    ...('actionKey' in src ? { actionKey: src.actionKey } : {}),
  })

  const invalidated = await many(c,
    `update app.proposals set status = 'invalidated', updated_at = $3,
       status_reason = 'booking changed (v' || based_on_booking_version || ' → v' || $2 || ')'
     where booking_id = $1 and status in ('draft','pending_approval','approved') and based_on_booking_version < $2
     returning id, work_item_id, status_reason`, [bookingId, nb.version, at])
  for (const p of invalidated) {
    await c.query(`update app.work_items set status = 'waiting', waiting_for = 'redraft', updated_at = $2 where id = $1`, [p.work_item_id, at])
    await trace(c, at, 'app', 'refusal', 'Proposal invalidated at once', { proposalId: p.id, workItemId: p.work_item_id, reason: p.status_reason })
  }

  const open = await many(c, `select id from app.work_items where booking_id = $1 and status <> 'done'`, [bookingId])
  for (const w of open) {
    if (src.provenance === 'assistant' && src.workItemId === w.id) {
      await trace(c, at, 'worker', 'state', 'No wake-up: change made by this work item’s own action', { workItemId: w.id, actionKey: src.actionKey })
      continue
    }
    await wakeBatched(c, w.id, invalidated.some(p => p.work_item_id === w.id) ? 'redraft after booking change' : 'booking changed', at)
  }
  return { before: b, after: nb, invalidated }
}
