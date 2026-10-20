// Stand-in for the model's reading of free text. Deterministic so the tests are about the mechanisms.
// With a real model, this is where understanding has to be evaluated separately (see README).

export function classifyRequest(subject: string, body: string): 'discount' | 'participants' {
  const t = `${subject} ${body}`.toLowerCase()
  if (/discount|% off|reduction/.test(t)) return 'discount'
  return 'participants'
}

export function parseHeadcount(text: string): number | null {
  const m = text.match(/(\d{1,3})\s+(people|guests)/i)
  return m ? Number(m[1]) : null
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9%£ ]+/g, ' ').split(/\s+/).filter(Boolean)

/** Returns the first run of `n` consecutive words that `text` shares with `source`, if any. */
export function sharedPhrase(text: string, source: string, n = 5): string | null {
  const a = normalise(text)
  const grams = new Set<string>()
  const b = normalise(source)
  for (let i = 0; i + n <= b.length; i++) grams.add(b.slice(i, i + n).join(' '))
  for (let i = 0; i + n <= a.length; i++) {
    const g = a.slice(i, i + n).join(' ')
    if (grams.has(g)) return g
  }
  return null
}
