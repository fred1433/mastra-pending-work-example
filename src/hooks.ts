// Test instrumentation: lets a test hold a transaction at a named point to force a given interleaving.
export type Pause = (label: string) => unknown
