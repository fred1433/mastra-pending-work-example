// SQL snapshot of the records the reading page shows, taken by the scenario after each step.
import type { Db } from './db.ts'
import { many } from './db.ts'
import type { Assistant } from './agent/assistant.ts'

export async function snapshot(db: Db, label: string, at: Date, a?: Assistant) {
  const data = {
    booking: (await many(db, 'select id, title, version, guests, total_cents, discount_pct from app.bookings'))[0],
    workItems: await many(db, 'select id, kind, status, waiting_for, mastra_thread from app.work_items order by id'),
    authorisations: await many(db, `select a.id, a.work_item_id, a.max_pct, a.revoked, s.name as granted_by from app.discount_authorizations a join app.staff s on s.id = a.granted_by order by a.id`),
    proposals: await many(db, `select p.id, p.revision, p.based_on_booking_version, (p.effects->>'totalAfterCents')::int as total_after_cents, p.reply_to, p.status, p.status_reason,
                                 p.mastra_run_id, p.revision = (select max(revision) from app.proposals q where q.work_item_id = p.work_item_id) as active
                               from app.proposals p order by p.id`),
    approvals: await many(db, `select a.id, a.proposal_id, s.name as approved_by, a.consumed_by_action from app.approvals a join app.staff s on s.id = a.approved_by order by a.id`),
    actions: await many(db, 'select key, status, attempts, provider_message_id from app.actions order by key'),
    wakeups: await many(db, 'select work_item_id, reasons, run_after, event_count, urgent, claimed_by from app.wakeups order by work_item_id'),
    providerMessages: Number((await many(db, 'select count(*) as n from provider.messages'))[0].n),
    suspendedRuns: a ? ((await (a.agent as any).listSuspendedRuns({ resourceId: 'org_1:booking:B-1042' })).runs ?? []).map((r: any) => ({
      runId: r.runId, threadId: r.threadId, proposalId: r.toolCalls?.[0]?.args?.proposalId ?? null })) : null,
  }
  await db.query('insert into app.snapshots (label, at, data) values ($1, $2, $3) on conflict (label) do update set at = excluded.at, data = excluded.data', [label, at, JSON.stringify(data)])
}
