export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/booking_demo'

/** Ordinary edits are grouped: the wake-up waits this long after the last one. */
export const BATCH_WINDOW_MS = 2 * 60_000
/** ...but never longer than this after the first one. */
export const BATCH_MAX_WAIT_MS = 10 * 60_000
/** Lease on an outgoing action before another worker may treat it as abandoned. */
export const ACTION_LEASE_MS = 30_000
/** How many recent messages Mastra memory puts back in the model's window. */
export const MODEL_WINDOW_MESSAGES = 4
