import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATABASE_URL } from './config.ts'

// Postgres `date` (oid 1082) stays a 'YYYY-MM-DD' string. The default parser builds a local-midnight Date,
// which shifts the day once serialised in any time zone east of UTC.
pg.types.setTypeParser(1082, (v: string) => v)

export type Db = pg.Pool
export type Tx = pg.PoolClient

export function connect(): Db {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 10 })
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('begin')
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))

/** Drops and recreates the demo schemas, including Mastra's. Used by tests and the scenario only. */
export async function resetDatabase(db: Db) {
  await db.query('drop schema if exists app cascade; drop schema if exists provider cascade; drop schema if exists mastra cascade;')
  await db.query(fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8'))
}

export async function one<T = any>(c: Db | Tx, sql: string, params: unknown[] = []): Promise<T> {
  const r = await c.query(sql, params)
  return r.rows[0] as T
}

export async function many<T = any>(c: Db | Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(sql, params)
  return r.rows as T[]
}
