import type { Db } from './db.ts'
import { tx, one } from './db.ts'
import { ACTION_LEASE_MS } from './config.ts'
import { trace } from './trace.ts'
import { providerSend } from './provider.ts'

export type DispatchOptions = {
  workerId: string
  at: Date
  /** Whether the provider honours an idempotency key. Without it, an unknown outcome is never resent blindly. */
  providerIdempotency?: boolean
  /** Test hook: kill this process right after the provider accepted, before the local acknowledgement. */
  crashAfterAccept?: boolean
}

export async function dispatchOne(db: Db, o: DispatchOptions) {
  const idem = o.providerIdempotency ?? true
  const lease = new Date(o.at.getTime() + ACTION_LEASE_MS)
  const a = await one(db,
    `update app.actions set status = 'claimed', claimed_by = $1, lease_until = $2, attempts = attempts + 1, updated_at = $3
     where key = (select key from app.actions
                  where status = 'pending' or (status = 'claimed' and lease_until < $3)
                  order by created_at for update skip locked limit 1)
     returning *`, [o.workerId, lease, o.at])
  if (!a) return { outcome: 'nothing_to_claim' as const }
  await trace(db, o.at, o.workerId, 'state', a.attempts > 1 ? 'Abandoned send reclaimed after lease expiry' : 'Send claimed', { actionKey: a.key, attempt: a.attempts })

  if (a.attempts > 1 && !idem) {
    await db.query(`update app.actions set status = 'delivery_unknown', updated_at = $2 where key = $1`, [a.key, o.at])
    await trace(db, o.at, o.workerId, 'refusal', 'Outcome unknown: not resent, shown to staff', { actionKey: a.key })
    return { outcome: 'delivery_unknown' as const, key: a.key }
  }

  const sent = await providerSend(db, { clientRef: a.key, idempotencyKey: idem ? a.key : null, to: a.payload.to, subject: a.payload.subject, body: a.payload.body })
  if (o.crashAfterAccept) process.kill(process.pid, 'SIGKILL')

  return tx(db, async c => {
    const done = await one(c,
      `update app.actions set status = 'sent', provider_message_id = $3, updated_at = $4
       where key = $1 and claimed_by = $2 and status = 'claimed' returning *`, [a.key, o.workerId, sent.providerMessageId, o.at])
    if (!done) return { outcome: 'lost_lease' as const, key: a.key }
    const p = await one(c, 'select * from app.proposals where id = $1', [a.proposal_id])
    const conv = await one(c,
      `select m.conversation_id from app.work_sources s join app.messages m on m.id = s.message_id where s.work_item_id = $1 and s.link = 'origin'`, [p.work_item_id])
    await c.query(`insert into app.messages (id, conversation_id, external_id, author_kind, author_ref, body, at) values ($1,$2,$3,'assistant',$4,$5,$6) on conflict do nothing`,
      [`OUT-${sent.providerMessageId}`, conv.conversation_id, sent.providerMessageId, a.key, a.payload.body, o.at])
    await c.query(`insert into app.events (org_id, booking_id, kind, provenance, actor, action_key, payload, at)
                   select org_id, booking_id, 'email_sent', 'assistant', 'assistant', $2, $3, $4 from app.work_items where id = $1`,
      [p.work_item_id, a.key, JSON.stringify({ providerMessageId: sent.providerMessageId }), o.at])
    await c.query(`update app.work_items set status = 'done', updated_at = $2 where id = $1`, [p.work_item_id, o.at])
    await trace(c, o.at, o.workerId, 'effect', sent.duplicate ? 'Provider returned the earlier message (same key)' : 'Email accepted by the provider', {
      actionKey: a.key, providerMessageId: sent.providerMessageId, to: a.payload.to, thread: conv.conversation_id,
    })
    await trace(c, o.at, 'worker', 'state', 'No wake-up: the sent email carries the assistant’s provenance', { actionKey: a.key })
    return { outcome: sent.duplicate ? 'deduplicated_by_provider' as const : 'sent' as const, key: a.key, providerMessageId: sent.providerMessageId }
  })
}
