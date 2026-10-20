import type { Db, Tx } from './db.ts'
import { many } from './db.ts'
import { BATCH_MAX_WAIT_MS, BATCH_WINDOW_MS } from './config.ts'
import { trace } from './trace.ts'

/**
 * Wake-up policy.
 *  new explicit request            -> now
 *  human decision linked to work   -> now
 *  dependency of a pending proposal-> proposal invalidated at once (bookings.ts), redraft batched
 *  ordinary edits                  -> batched: one wake after a quiet window, capped by a max wait
 *  unrelated edit                  -> nothing
 *  event produced by the assistant -> recognised by provenance, never wakes the work that caused it
 *  deadline                        -> the due work item wakes from its durable state
 */
export async function wakeNow(c: Tx, workItemId: string, reason: string, at: Date) {
  await c.query(
    `insert into app.wakeups (work_item_id, reasons, first_event_at, run_after)
     values ($1, array[$2], $3, $3)
     on conflict (work_item_id) do update
       set reasons = app.wakeups.reasons || $2, run_after = least(app.wakeups.run_after, $3),
           event_count = app.wakeups.event_count + 1`,
    [workItemId, reason, at],
  )
  await trace(c, at, 'worker', 'state', 'Wake-up queued now', { workItemId, reason })
}

export async function wakeBatched(c: Tx, workItemId: string, reason: string, at: Date) {
  const r = await c.query(
    `insert into app.wakeups (work_item_id, reasons, first_event_at, run_after)
     values ($1, array[$2], $3, $3::timestamptz + $4 * interval '1 millisecond')
     on conflict (work_item_id) do update
       set reasons = app.wakeups.reasons || $2,
           run_after = greatest(app.wakeups.run_after,
                         least($3::timestamptz + $4 * interval '1 millisecond',
                               app.wakeups.first_event_at + $5 * interval '1 millisecond')),
           event_count = app.wakeups.event_count + 1
     returning run_after, event_count`,
    [workItemId, reason, at, BATCH_WINDOW_MS, BATCH_MAX_WAIT_MS],
  )
  const row = r.rows[0]
  await trace(c, at, 'worker', 'state', row.event_count > 1 ? 'Wake-up pushed back, edits grouped' : 'Wake-up batched', {
    workItemId, reason, runAfter: row.run_after, groupedEvents: row.event_count,
  })
}

export type DueWake = { workItemId: string; reasons: string[]; groupedEvents: number }

/** Claims due wake-ups and deadlines. SKIP LOCKED keeps two workers from taking the same one. */
export async function claimDue(db: Db, at: Date): Promise<DueWake[]> {
  const woken = await many(db,
    `delete from app.wakeups where work_item_id in (
       select work_item_id from app.wakeups where run_after <= $1 order by run_after for update skip locked)
     returning work_item_id, reasons, event_count`, [at])
  const deadlines = await many(db,
    `update app.work_items set resume_at = null, updated_at = $1
     where resume_at <= $1 and status <> 'done' returning id`, [at])
  const out: DueWake[] = woken.map(w => ({ workItemId: w.work_item_id, reasons: w.reasons, groupedEvents: w.event_count }))
  for (const d of deadlines) {
    const found = out.find(o => o.workItemId === d.id)
    if (found) found.reasons.push('deadline reached')
    else out.push({ workItemId: d.id, reasons: ['deadline reached'], groupedEvents: 1 })
  }
  return out
}
