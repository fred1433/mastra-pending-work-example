import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, resetDatabase } from '../src/db.ts'
import { seed } from '../src/seed.ts'
import { exportTrace } from './export.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const db = connect()
await resetDatabase(db)
await seed(db)
for (const phase of ['1', '2']) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(here, 'phase.ts'), phase], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
  if (r.status !== 0) { console.error(`phase ${phase} failed with ${r.status}`); process.exit(1) }
}
const out = await exportTrace(db)
// TRACE_DIR lets the tests write elsewhere, so `npm test` leaves the committed trace alone.
const dir = process.env.TRACE_DIR ?? path.join(here, '..', 'trace')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'scenario-trace.json'), JSON.stringify(out, null, 2) + '\n')
fs.writeFileSync(path.join(dir, 'scenario-trace.md'), out.markdown)
if (!process.env.TRACE_DIR) console.log(out.markdown)
await db.end()
