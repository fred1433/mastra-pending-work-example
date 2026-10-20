import type { Db, Tx } from './db.ts'

export type TraceKind = 'input' | 'link' | 'state' | 'model' | 'gate' | 'refusal' | 'effect' | 'process'

export async function trace(c: Db | Tx, at: Date, actor: string, kind: TraceKind, step: string, detail: Record<string, unknown> = {}) {
  await c.query('insert into app.trace (at, pid, actor, kind, step, detail) values ($1,$2,$3,$4,$5,$6)', [
    at, process.pid, actor, kind, step, JSON.stringify(detail),
  ])
}

export function money(cents: number) {
  return '£' + (cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
