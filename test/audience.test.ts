import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RequestContext } from '@mastra/core/request-context'
import { freshWorld, discountPending, at, MAYA_DECIDES } from './helpers.ts'
import { draftProposal } from '../src/proposals.ts'
import { receiveEmail } from '../src/ingest.ts'
import { buildTools } from '../src/agent/tools.ts'

const base = { workItemId: 'W1', discountPct: 10, subject: 'Re: Discount for our team dinner' }

test('audience: the internal note justifies the discount without being repeated to the customer', async () => {
  const { db, a, close } = await freshWorld()
  try {
    const r1 = await discountPending(db, a)
    assert.ok(r1.evidence.some((id: string) => id.startsWith('NOTE-')), 'the decision is recorded as evidence')
    assert.ok(!/margin|repeat client/i.test(r1.reply_body))
    assert.deepEqual(r1.reply_to, ['sarah@northfield.example'])
  } finally { await close() }
})

test('audience: a draft that repeats the internal note is rejected by the application', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await discountPending(db, a)
    const r: any = await draftProposal(db, { ...base, to: ['sarah@northfield.example'], body: `Hi Sarah, approved: repeat client, and the margin on this menu covers it. New total £720.00.` }, at(26))
    assert.equal(r.status, 'rejected')
    assert.match(r.reason, /repeats internal note/)
    assert.ok(MAYA_DECIDES.toLowerCase().includes('the margin on this menu covers it'))
  } finally { await close() }
})

test('audience: recipients outside the request’s external threads are rejected', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await discountPending(db, a)
    await receiveEmail(db, { conversationId: 'B', externalId: 'b1', from: 'dev@northfield.example', body: 'We will be 10 people, not 8.', at: at(26) })
    for (const to of ['maya@venue.example', 'dev@northfield.example']) {
      const r: any = await draftProposal(db, { ...base, to: [to], body: 'Hi, the total is now £720.00.' }, at(26))
      assert.equal(r.status, 'rejected', to)
      assert.match(r.reason, /recipient not in this request/)
    }
  } finally { await close() }
})

test('scope: a tool call naming another work item than the run’s is refused', async () => {
  const { db, a, close } = await freshWorld()
  try {
    await discountPending(db, a)
    const tools = buildTools(db)
    const rc = new RequestContext(); rc.set('workItemId', 'W1'); rc.set('now', at(26).toISOString())
    const r: any = await (tools.readWorkContext as any).execute({ workItemId: 'W9' }, { requestContext: rc })
    assert.equal(r.status, 'refused')
  } finally { await close() }
})
