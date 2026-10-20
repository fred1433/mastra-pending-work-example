// Scripted stand-in for the language model: a pure function of the prompt Mastra sends, so it behaves the
// same in a fresh process after a restart. It exercises the mechanisms; it says nothing about how well a
// real model reads free text or writes a reply.
import crypto from 'node:crypto'
import { MockLanguageModelV3 } from 'ai/test'
import { parseHeadcount } from '../intake.ts'

type Decision = { tool: string; input: Record<string, unknown> } | { text: string }
export type ModelObserver = (seen: { messages: number; roles: string[]; wakesVisible: number; lastTool?: string }) => void
let observer: ModelObserver | null = null
export const observeModel = (fn: ModelObserver | null) => { observer = fn }

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }

function lastToolResult(prompt: any[]) {
  const last = prompt[prompt.length - 1]
  if (last?.role !== 'tool') return null
  const part = [...last.content].reverse().find((p: any) => p.type === 'tool-result')
  if (!part) return null
  const o = part.output
  const value = o?.type === 'json' ? o.value : o?.type === 'text' ? safeJson(o.value) : o?.value ?? o
  return { toolName: part.toolName as string, value: value as any, raw: o }
}
const safeJson = (s: string) => { try { return JSON.parse(s) } catch { return { text: s } } }

function wakeTarget(prompt: any[]): string | null {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]
    if (m.role !== 'user') continue
    const text = (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join(' ') : String(m.content))
    const hit = text.match(/work="([^"]+)"/)
    if (hit) return hit[1]
  }
  return null
}

export function decide(prompt: any[]): Decision {
  const last = prompt[prompt.length - 1]
  const workItemId = wakeTarget(prompt)
  if (last?.role === 'user') {
    // Test-only directive: submit a given proposal straight away (used to exercise beforeApproval).
    const direct = JSON.stringify(last.content).match(/submit=\\"([^"\\]+)\\"/)
    if (direct) return { tool: 'submitProposal', input: { proposalId: direct[1] } }
    return workItemId ? { tool: 'readWorkContext', input: { workItemId } } : { text: 'Nothing to do.' }
  }
  const r = lastToolResult(prompt)
  if (!r) return { text: 'Nothing to do.' }
  const v = r.value ?? {}

  if (r.toolName === 'readWorkContext') {
    if (v.status === 'refused') return { text: v.reason }
    const { workItem, booking, authorisation, latestProposal, origin, sources } = v
    if (workItem.kind === 'participants') {
      const asked = sources.map((s: any) => parseHeadcount(s.text)).find((n: number | null) => n !== null)
      if (asked && asked === booking.guests) return { tool: 'closeWork', input: { workItemId: workItem.id, outcome: `Headcount ${asked} is now recorded on booking v${booking.version}. Nothing to send.` } }
      return { tool: 'recordWaiting', input: { workItemId: workItem.id, waitingFor: 'booking_update', note: `The thread asks for ${asked} guests; the booking shows ${booking.guests}. Staff updates the CRM.` } }
    }
    if (latestProposal && ['pending_approval', 'approved'].includes(latestProposal.status)) return { text: `${latestProposal.id} is already ${latestProposal.status}.` }
    if (!authorisation) return { tool: 'recordWaiting', input: { workItemId: workItem.id, waitingFor: 'manager_decision', note: 'Discount requested; no manager decision is linked yet.' } }
    const pct = authorisation.maxPct
    const before = Number(String(booking.totalBeforeDiscount).replace(/[£,]/g, ''))
    const after = '£' + (before * (1 - pct / 100)).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const customer = origin.participants[0]
    const body = [
      `Hi ${customer.name.split(' ')[0]},`,
      ``,
      `Thank you for your message about ${booking.title} on ${booking.eventDate}. We can offer ${pct}% off: for ${booking.guests} guests the total is now ${after} instead of ${booking.totalBeforeDiscount}.`,
      ``,
      `An updated confirmation follows once the change is applied.`,
      ``,
      `Kind regards,`,
      `The events team`,
    ].join('\n')
    return { tool: 'draftProposal', input: { workItemId: workItem.id, discountPct: pct, to: origin.participants.map((p: any) => p.address), subject: `Re: ${origin.subject}`, body } }
  }
  if (r.toolName === 'draftProposal') {
    if (v.status === 'drafted') return { tool: 'submitProposal', input: { proposalId: v.proposalId } }
    return { text: `Draft not possible: ${v.reason}` }
  }
  if (r.toolName === 'submitProposal') {
    if (v.status === 'executed' || v.status === 'already_executed') return { text: `Done: ${v.actionKey} queued.` }
    if (v.status === 'stale' || v.status === 'content_changed') {
      const w = v.proposalId?.split('-r')[0] ?? wakeTarget(prompt)
      return { tool: 'readWorkContext', input: { workItemId: w } }
    }
    if (v.status === 'rejected_before_approval') return { text: `Not shown for approval: ${v.reason}` }
    return { text: `Proposal withdrawn: ${JSON.stringify(v).slice(0, 160)}` }
  }
  return { text: `${r.toolName}: ${v.status ?? 'ok'}` }
}

export function fakeModel() {
  const run = (opts: any) => {
    const d = decide(opts.prompt)
    const wakesVisible = opts.prompt.filter((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('<wake work=')).length
    observer?.({ messages: opts.prompt.length, roles: opts.prompt.map((m: any) => m.role), wakesVisible, lastTool: 'tool' in d ? d.tool : undefined })
    return d
  }
  return new MockLanguageModelV3({
    provider: 'scripted',
    modelId: 'deterministic-booking-planner',
    doGenerate: async (opts: any) => {
      const d = run(opts)
      const content = 'tool' in d
        ? [{ type: 'tool-call', toolCallId: `call_${crypto.randomUUID().slice(0, 8)}`, toolName: d.tool, input: JSON.stringify(d.input) }]
        : [{ type: 'text', text: d.text }]
      return { content, finishReason: { unified: 'tool' in d ? 'tool-calls' : 'stop', raw: 'scripted' }, usage, warnings: [] } as any
    },
  } as any)
}
