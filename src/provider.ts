// A fake email provider that persists outside the app schema, so it survives a killed process.
import crypto from 'node:crypto'
import type { Db } from './db.ts'
import { one } from './db.ts'

export type OutgoingEmail = { clientRef: string; idempotencyKey: string | null; to: string[]; subject: string; body: string }

export async function providerSend(db: Db, m: OutgoingEmail): Promise<{ providerMessageId: string; duplicate: boolean }> {
  if (m.idempotencyKey) {
    const r = await one(db,
      `insert into provider.messages (id, idempotency_key, client_ref, to_addr, subject, body) values ($1,$2,$3,$4,$5,$6)
       on conflict (idempotency_key) do nothing returning id`,
      [`pm_${crypto.randomUUID().slice(0, 8)}`, m.idempotencyKey, m.clientRef, m.to, m.subject, m.body])
    if (r) return { providerMessageId: r.id, duplicate: false }
    const ex = await one(db, 'select id from provider.messages where idempotency_key = $1', [m.idempotencyKey])
    return { providerMessageId: ex.id, duplicate: true }
  }
  const r = await one(db, `insert into provider.messages (id, client_ref, to_addr, subject, body) values ($1,$2,$3,$4,$5) returning id`,
    [`pm_${crypto.randomUUID().slice(0, 8)}`, m.clientRef, m.to, m.subject, m.body])
  return { providerMessageId: r.id, duplicate: false }
}
