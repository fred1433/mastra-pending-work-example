import type { Db, Tx } from './db.ts'
import { tx, many } from './db.ts'
import { BATCH_MAX_WAIT_MS, BATCH_WINDOW_MS, WAKE_LEASE_MS } from './config.ts'
import { trace } from './trace.ts'

/**
 * Wake-up policy.
 *  new explicit request            -> now
 *  human decision linked to work   -> now (and stays urgent if ordinary edits follow)
 *  dependency of a pending proposal-> proposal invalidated at once (bookings.ts), redraft batched
 *  ordinary edits                  -> batched: one wake after a quiet window, capped by a max wait
 *  unrelated edit                  -> nothing
 *  event produced by the assistant -> recognised by provenance, never wakes the work that caused it
 *  deadline                        -> becomes a wake-up row, then follows the same claim and ack
 *
 * Delivery is at least once: a row is claimed with a lease and deleted only after the run has
 * reached a durable result (ackWake). A worker that dies leaves the row for the next one.
 */
export async function wakeNow(c: Tx, workItemId: string, reason: string, at: Date) {
  await c.query(
    `insert into app.wakeups (work_item_id, reasons, first_event_at, last_event_at, run_after, urgent)
     values ($1, array[$2], $3, $3, $3, true)
     on conflict (work_item_id) do update
       set reasons = app.wakeups.reasons || $2, run_after = least(app.wakeups.run_after, $3), urgent = true,
           last_event_at = $3, event_count = app.wakeups.event_count + 1`,
    [workItemId, reason, at],
  )
  await trace(c, at, 'worker', 'state', 'Wake-up queued now', { workItemId, reason })
}

export async function wakeBatched(c: Tx, workItemId: string, reason: string, at: Date) {
  const r = await c.query(
    `insert into app.wakeups (work_item_id, reasons, first_event_at, last_event_at, run_after)
     values ($1, array[$2], $3, $3, $3::timestamptz + $4 * interval '1 millisecond')
     on conflict (work_item_id) do update
       set reasons = app.wakeups.reasons || $2,
           last_event_at = $3,
           run_after = case when app.wakeups.urgent then app.wakeups.run_after else
                         greatest(app.wakeups.run_after,
                           least($3::timestamptz + $4 * interval '1 millisecond',
                                 app.wakeups.first_event_at + $5 * interval '1 millisecond')) end,
           event_count = app.wakeups.event_count + 1
     returning run_after, event_count, urgent`,
    [workItemId, reason, at, BATCH_WINDOW_MS, BATCH_MAX_WAIT_MS],
  )
  const row = r.rows[0]
  await trace(c, at, 'worker', 'state',
    row.urgent ? 'Wake-up already due now: edit added to it' : row.event_count > 1 ? 'Wake-up pushed back, edits grouped' : 'Wake-up batched', {
      workItemId, reason, runAfter: row.run_after, groupedEvents: row.event_count,
    })
}

export type Claim = { workItemId: string; reasons: string[]; groupedEvents: number; generation: number; workerId: string }

/**
 * Turns due deadlines into wake-up rows, then claims due rows under a lease (SKIP LOCKED: two workers
 * never take the same one). Nothing is deleted here.
 */
export async function claimDue(db: Db, at: Date, workerId = 'worker', limit = 100): Promise<Claim[]> {
  await tx(db, async c => {
    await c.query(
      `with due as (
         update app.work_items set resume_at = null, updated_at = $1
         where resume_at <= $1 and status <> 'done' returning id, $1::timestamptz as at)
       insert into app.wakeups (work_item_id, reasons, first_event_at, last_event_at, run_after, urgent)
       select id, array['deadline reached'], at, at, at, true from due
       on conflict (work_item_id) do update
         set reasons = app.wakeups.reasons || 'deadline reached'::text, run_after = least(app.wakeups.run_after, excluded.run_after),
             urgent = true, last_event_at = excluded.last_event_at, event_count = app.wakeups.event_count + 1`, [at])
  })
  const rows = await many(db,
    `update app.wakeups set claimed_by = $2, claimed_until = $1::timestamptz + $3 * interval '1 millisecond'
     where work_item_id in (
       select work_item_id from app.wakeups
       where run_after <= $1 and (claimed_until is null or claimed_until < $1)
       order by run_after, work_item_id limit $4 for update skip locked)
     returning work_item_id, reasons, event_count`, [at, workerId, WAKE_LEASE_MS, limit])
  return rows.map(r => ({ workItemId: r.work_item_id, reasons: r.reasons, groupedEvents: r.event_count, generation: r.event_count, workerId }))
}

/** After a durable result: delete the row, unless new events arrived during the run (then just release it). */
export async function ackWake(db: Db, c: Claim) {
  const del = await db.query(`delete from app.wakeups where work_item_id = $1 and claimed_by = $2 and event_count = $3`, [c.workItemId, c.workerId, c.generation])
  if (!del.rowCount) await releaseWake(db, c)
  return del.rowCount === 1
}

export async function releaseWake(db: Db, c: Claim) {
  await db.query(`update app.wakeups set claimed_by = null, claimed_until = null where work_item_id = $1 and claimed_by = $2`, [c.workItemId, c.workerId])
}
