import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core'
import { Memory } from '@mastra/memory'
import { PostgresStore } from '@mastra/pg'
import { DATABASE_URL, MODEL_WINDOW_MESSAGES } from '../config.ts'
import type { Db } from '../db.ts'
import { buildTools } from './tools.ts'
import { fakeModel } from './fake-model.ts'

const INSTRUCTIONS = `You prepare the work for one request on one booking.
Always read the request's context first; the booking in Postgres is the current truth, older messages are not.
Never write internal notes into a customer reply. Prepare changes as a proposal and ask for approval.`

/** One Mastra instance per worker process. Mastra state lives in the same Postgres, schema "mastra". */
export function buildAssistant(db: Db, opts: { decide?: (prompt: any[]) => any } = {}) {
  const storage = new PostgresStore({ id: 'mastra-pg', connectionString: DATABASE_URL, schemaName: 'mastra' })
  const agent = new Agent({
    id: 'booking-assistant',
    name: 'Booking assistant',
    instructions: INSTRUCTIONS,
    model: fakeModel(opts.decide) as any, // MockLanguageModelV3 from ai/test; the typings expect a streaming model
    tools: buildTools(db),
    memory: new Memory({ options: { lastMessages: MODEL_WINDOW_MESSAGES } }),
  })
  const mastra = new Mastra({ agents: { assistant: agent }, storage, logger: false })
  const close = async () => { await mastra.shutdown().catch(() => {}); await storage.close().catch(() => {}) }
  return { mastra, agent: mastra.getAgent('assistant'), close }
}
export type Assistant = ReturnType<typeof buildAssistant>
