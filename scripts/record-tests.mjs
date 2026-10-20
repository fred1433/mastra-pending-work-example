// Runs the suite, keeps its output in trace/test-run.txt, and exits with the suite's own code.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
const out = fs.createWriteStream(new URL('../trace/test-run.txt', import.meta.url))
const p = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=spec', ...fs.readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`)], { stdio: ['ignore', 'pipe', 'pipe'] })
for (const s of [p.stdout, p.stderr]) s.on('data', d => { process.stdout.write(d); out.write(d) })
p.on('exit', code => out.end(() => process.exit(code ?? 1)))
