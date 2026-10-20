import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, resetDatabase, one, many, type Db } from '../src/db.ts'
import { seed, at } from '../src/seed.ts'
import { buildAssistant, type Assistant } from '../src/agent/assistant.ts'
import { receiveEmail, addInternalNote } from '../src/ingest.ts'
import { runDue } from '../src/worker.ts'

export { at, one, many }
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function freshWorld(opts: { assistant?: boolean } = {}) {
  const db = connect()
  await resetDatabase(db)
  await seed(db)
  const a = opts.assistant === false ? null : buildAssistant(db)
  return { db, a: a as Assistant, close: async () => { await a?.close(); await db.end() } }
}

export const SARAH_ASKS = 'Hello, we are booked for the team dinner on 14 November. Would a 10% discount be possible? We have held our last three events with you.'
export const MAYA_DECIDES = 'OK for 10%. Repeat client, and the margin on this menu covers it.'

/** Email in thread A, manager decision with an explicit reference, agent run: W1-r1 waits for approval. */
export async function discountPending(db: Db, a: Assistant) {
  await receiveEmail(db, { conversationId: 'A', externalId: 'a1', from: 'sarah@northfield.example', body: SARAH_ASKS, at: at(2) })
  await runDue(db, a, at(2))
  await addInternalNote(db, { bookingId: 'B-1042', staffId: 'u_maya', refWorkItemId: 'W1', decision: { approve: true, maxPct: 10 }, body: MAYA_DECIDES, at: at(25) })
  await runDue(db, a, at(25))
  return one(db, `select * from app.proposals where id = 'W1-r1'`)
}

export async function count(db: Db, table: string, where = 'true', params: unknown[] = []) {
  return Number((await one(db, `select count(*) as n from ${table} where ${where}`, params)).n)
}

export type ChildResult = { code: number | null; signal: NodeJS.Signals | null; out: any; stderr: string }

/** Runs scripts/child.ts in a separate OS process. */
export function child(args: string[], env: Record<string, string> = {}): Promise<ChildResult> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'scripts', 'child.ts'), ...args], { env: { ...process.env, ...env }, cwd: root })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => (stdout += d))
    p.stderr.on('data', d => (stderr += d))
    p.on('exit', (code, signal) => {
      const line = stdout.trim().split('\n').filter(l => l.startsWith('{')).pop()
      resolve({ code, signal, out: line ? JSON.parse(line) : null, stderr })
    })
  })
}
