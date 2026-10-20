# Booking assistant on Mastra: pending work under a changing booking

A small, runnable answer to one architecture question. Sarah asks for 10% off by email. Maya, a manager, agrees through an internal note. Meanwhile Dev, in a second thread, raises the headcount, and staff update the booking before anyone has approved the reply. What should the assistant do, and which part of that is Mastra's job?

Everything here runs on Postgres with a scripted model: no API key, no model cost. The booking, people and addresses are fictional.

## The recommendation

Keep the booking and each piece of pending work in Postgres, and give Mastra one thread per piece of work under one resource per booking, so nothing that matters lives only in the model's window. Let Mastra suspend and resume the approval; let the application bind each approval to one exact revision, recheck the booking inside `execute()`, and record the email to send in the same transaction.

## Run it

```bash
npm ci
npm run db:up      # Postgres 17.6 on localhost:54329 (docker compose)
npm test           # 36 tests, about 50 s; any failure exits with code 1
npm run scenario   # replays the scenario in two OS processes, writes trace/scenario-trace.{md,json}
```

To use another Postgres, set `DATABASE_URL`. The tests drop and recreate the schemas `app`, `provider` and `mastra` in that database, so point it at a throwaway one.

| Pinned | Version |
|---|---|
| Node | 26.8.2 in `.nvmrc`; `engines` asks for >= 22.13, as Mastra does |
| @mastra/core | 1.78.0 |
| @mastra/memory | 1.38.0 |
| @mastra/pg | 1.31.2 |
| ai (AI SDK) | 7.0.146 |
| zod | 4.6.7 |
| pg | 8.23.1 |

`package-lock.json` is committed. The output of a passing run is kept in [`trace/test-run.txt`](trace/test-run.txt) (PostgreSQL 17.6 in Docker). The suite also passed on PostgreSQL 14.23. `npm test` runs its scenario replays in a temporary folder and leaves `trace/` untouched; `npm run scenario` rewrites it.

## Decisions

| Object | Decision |
|---|---|
| Booking | A business entity in Postgres. Its current row is the authority; nothing in memory overrides it. |
| Pending work | One persistent `work_items` row per active request or topic (a discount, a headcount change), with its status, its linked sources and what it waits for. Ids come from a sequence. |
| Internal decisions | Authority comes from the session and from the note box's controls (approve or decline, and the percentage). The note's text is kept as evidence; no amount or authority is ever read from it. |
| Source conversations | Email threads, notes and transcripts keep their ids, authors and audience. Several can feed one work item (`work_sources`, with the reason for each link). |
| Mastra context | One resource per booking in its organisation (`org_1:booking:B-1042`), one thread per work item (`work:W1`, `work:W2`). Evidence from other threads is fetched explicitly by a tool. This is an architecture choice, not something Mastra imposes. |
| Mastra execution | One run per step or resume, linked to the work item. A runId is never the business identity of anything. |
| Proposal | A versioned set of changes plus the reply, its recipients and the evidence it rests on. The booking version it was built on is recorded by the application from its own read, never taken from the model. |

## What Mastra does, what the application does

**Mastra** suspends the `submitProposal` tool call (`requireApproval: true`), persists the suspended run in Postgres through `@mastra/pg`, and resumes it later, in another process if needed (`approveToolCallGenerate`, `declineToolCallGenerate`, `listSuspendedRuns`). Memory gives each work item its own thread. `beforeApproval` (new in 1.78.0) rejects a proposal that is already unusable before a person sees it.

**The application** owns everything that must still be true at execution time:

- Two separate agreements. A manager authorises a discount with a defined scope (`discount_authorizations`). A person approves one exact proposal revision (`approvals`, bound to a content hash of text, recipients, effects and booking version). A regenerated draft is a new revision and needs a new approval.
- `beforeApproval` is not re-run on resume. The 1.78.0 typings say so: "Not run on resume, so keep validating inside `execute` if state can change while paused." So `execute()` re-reads the booking, the proposal and the manager's authorisation under row locks, and only when every check passes does it consume the approval, apply the change and insert the intent to send, in one transaction. A refusal leaves the approval unconsumed.
- Two things observed on 1.78.0 while building this. `beforeApproval` receives `requestContext` as a plain object, while `execute` receives a `RequestContext`. And per the typings, "If the hook throws, the error is logged and the call continues to the approval gate." The hook here never throws: on bad input it rejects.
- Also observed on 1.78.0 with `@mastra/pg`: a second concurrent resume of the same run is rejected by Mastra (`AGENT_RESUME_ALREADY_CLAIMED`, or "could not find a suspended run" once the first has finished). The application does not rely on it. Mastra's durable-agents page warns that recovery can re-execute tool calls, so the action key comes from the proposal revision (`send-reply:W1-r2`), not from the run.

## The scenario

`npm run scenario` replays this in two OS processes. The full trace with every row is in [`trace/scenario-trace.md`](trace/scenario-trace.md).

1. 09:02 Thread A, Sarah asks for 10%. Work item W1 opens on thread `work:W1`, waits for a manager decision.
2. 09:10 Thread B, Dev says they will be 10, not 8. W2 opens on `work:W2` (same resource), waits for the booking to be updated.
3. 09:25 Maya, a manager (identity from the session), approves up to 10% with the controls of W1's note box and adds a reason in the text: an explicit link and an authorisation of up to 10% for W1 only.
4. 09:25 W1 reads the booking (v1, 8 guests, £800.00) and drafts W1-r1: £720.00 to Sarah. Mastra suspends for approval.
5. 09:31 Tom changes the guests to 10 in the CRM: booking v2, £1,000.00. W1-r1 is invalidated in the same transaction and the suspended call is declined. The redraft is batched.
6. 09:32 Tom clicks approve on W1-r1 from a stale screen: refused.
7. 09:32:30 Tom edits the title (v3): the wake-up is pushed back, the two edits are grouped. A contact phone edit wakes nothing.
8. 09:34:30 One wake-up each. W2 sees 10 guests and closes. W1 drafts W1-r2 on v3: £900.00. Of W1's three wake-ups, the model's window now holds two; the request, the decision and the booking come from Postgres through `readWorkContext`.
9. Process 1 exits. Process 2 starts with empty memory and finds the suspended run in Postgres.
10. 09:51 Tom double-clicks approve on W1-r2: one approval. The run resumes; `execute()` finds v3 unchanged, consumes the approval, applies 10% (v4, provenance `assistant`, which wakes nothing) and records `send-reply:W1-r2`.
11. 09:51:12 The outbox worker claims the action; the provider accepts it with the action key as idempotency key; the reply lands in thread A; W1 is done.

## Tests, and exactly what each proves

| Area | Test | What it proves | What it does not |
|---|---|---|---|
| Stale proposal | an invalidated proposal cannot be approved, and the redraft waits for its own approval | A booking change invalidates at once; the hash approved for r1 does not approve r2 | |
| | approved, then the booking changes before execution | `execute()` refuses, the approval stays unconsumed, the run redrafts and suspends again on a new revision | |
| | a change made behind the application (raw SQL) | `execute()` catches a version change even when the invalidation path never ran | Changes to tables other than `bookings` (see limits) |
| | editing text, recipients or effects after approval | Each edit makes `execute()` refuse; three new revisions, nothing sent | |
| | beforeApproval keeps an already stale draft from being shown | The Mastra hook rejects before suspension; no run is attached to the draft | |
| Duplicates | double click | Atomic conditional update: one approval row, the second click gets the same id | |
| | two executions from different runs | One action keyed on the proposal revision; the discount applied once | |
| | second concurrent resume of the same run (two processes) | Mastra 1.78.0 rejects the second resume | That this holds in other Mastra versions |
| | two worker processes on the same send | `FOR UPDATE SKIP LOCKED` plus a lease: one claim, one provider message | |
| | provider accepted, process killed (SIGKILL) before the local ack, provider honours idempotency | The retry after lease expiry gets the provider's existing message back: one email | Any real provider's idempotency window |
| | same crash, provider without idempotency | The action becomes `delivery_unknown` and is not resent | How staff resolve it |
| Notes | explicit reference from the note box | Deterministic link and a scoped manager authorisation, with the amount from the controls | |
| | a manager declines ("No, not 10%. Offer 5% at most.") | Nothing authorised; an earlier authorisation on the request is withdrawn | |
| | a counter-proposal (5%) and "OK for 12.5%" | The recorded amount is exactly the one decided (5, 12.5), never one read from the text | |
| | a manager's text alone ("OK for 10%", no decision) | Linked as evidence, nothing authorised | |
| | emails arriving together | Distinct work item ids from a sequence (five rounds of three concurrent emails) | |
| | free reference ("Fine to give Sarah the 10% she asked for") | A suggested link with its evidence; no authorisation and no wake-up until a manager confirms | How well a real model matches free text |
| | ambiguous ("OK for 10%" with two open requests) | A clarification listing both; nothing approved | |
| | a customer writes "your manager already agreed" | No authorisation: authority comes from the server-side staff identity | |
| | a coordinator writes "OK for 10%" with an explicit reference | Linked as evidence, not an authorisation | |
| | the manager's authorisation is revoked after approval | `execute()` refuses, the approval stays unconsumed, nothing is queued | |
| Audience | the internal note justifies the discount | The note is evidence on the proposal; its wording is not in the reply | Tone or quality of a real draft |
| | a draft repeating the note | Rejected (any five consecutive words shared with an internal note) | Paraphrases |
| | recipients outside the request's external threads | Rejected, including a participant of another thread on the same booking | |
| | a tool call naming another work item | Refused: tools trust the worker's scope, not the model's arguments | |
| Restart | process 1 suspends and exits, process 2 resumes | Different PIDs, same database, the run found through `listSuspendedRuns`, executed once | A crash in the middle of a run (that is the durable-agents recovery path, not used here) |
| Wake-ups | new request, linked decision | Wake now | |
| | changed dependency | Proposal invalidated in the same transaction; redraft only after the window | |
| | burst of edits | One wake-up after a 2 min quiet window, and after at most 10 min if edits never stop | Tuning for real traffic |
| | unrelated edit (contact phone) | No wake-up | |
| | assistant's own events | Recognised by provenance; no loop | |
| | deadline | The work item wakes from its stored `resume_at` | |
| End to end | the scenario above | Order of steps, final state, two processes, two Mastra threads under one resource | |
| | the same scenario under `TZ=Asia/Dubai` and `TZ=America/Los_Angeles` | The reply still says 14 November and the content hash is unchanged (Postgres `date` is read as text) | |

## Wake-up rules

| Event | Behaviour |
|---|---|
| New explicit request | Create or find the work item, wake now |
| Human decision linked to a request | Wake now, re-read current state |
| Change to a dependency of a pending proposal | Invalidate the proposal in the same transaction; redraft after the batch window |
| Series of ordinary edits | One wake-up after 2 min of quiet, at most 10 min after the first |
| Edit unrelated to open work | Nothing |
| Event produced by the assistant | Recognised by provenance and action key; never wakes the work that caused it |
| Deadline reached | Wake the work item from its durable state |

Invalidation and redraft run on different clocks on purpose: an old draft stops being executable at once, and the model is not called for every cell edit.

## Mastra facilities: kept, deferred, and when to bring them in

Checked against the docs shipped inside `@mastra/core@1.78.0` (`node_modules/@mastra/core/dist/docs/references/`).

| Facility | Here | Why | Bring it in when |
|---|---|---|---|
| Tool approval (`requireApproval`, `beforeApproval`, approve/decline) | Used | The pause for a human is Mastra's job | |
| Memory: resource and thread | Used | One thread per work item under one resource per booking | |
| `@mastra/pg` storage | Used | Same Postgres as the app, schema `mastra` | |
| Signals (added in 1.39.0) and state signals | Deferred | Runs here are short; wake-ups are rows the web app writes and one worker consumes | A run lasts long enough that a new email should reach it mid-run |
| Notification signals, priority-aware delivery with summaries | Deferred | Batching here depends on business rules (dependency or not) and must commit with the invalidation | Low-stakes events (FYI edits, mentions) that the agent can read in bulk |
| Schedules (added in 1.50.0, persisted, cron) | Deferred | A deadline is one column on the work item, checked by the worker tick | Recurring work such as a daily digest of open requests |
| Multi-user threads | Not used | Speakers are carried as sources with server-side authors | Staff and the assistant share one conversation thread |
| PubSub: Redis Streams, Unix socket, Google Cloud Pub/Sub | Not used | One persistent worker; the default in-memory pub/sub is enough inside one process | Several workers must share the same active threads. Redis Streams gives cross-instance delivery and leases; the Unix socket transport covers several processes on one host; Google Cloud Pub/Sub crosses hosts without leases |

Starting point: Next.js routes record inputs in Postgres (`src/ingest.ts` is what they would call), and one Mastra worker on Railway consumes them (`src/worker.ts`). No Redis.

## Moving to Supabase

Mastra storage already uses `@mastra/pg`. Point `DATABASE_URL` at the Supabase database, apply `db/schema.sql` as a migration, and give the long-running worker a direct or session-mode connection; routes that only insert events can use the transaction pooler. If a file database is handier for local demos, `@mastra/libsql` (`new LibSQLStore({ id, url: 'file:./mastra.db' })`) can hold Mastra's state; the application tables still need Postgres for the row locks and `SKIP LOCKED`. None of this was run against Supabase here.

## Limits

- The model is scripted (`src/agent/fake-model.ts`): a pure function of the prompt, so it behaves the same after a restart. It proves the mechanisms. How well a real model understands free notes, matches them to requests and writes replies has to be evaluated separately, with a real model.
- One `booking.version` for the whole row is deliberately conservative: any booking edit invalidates a pending proposal, even one unrelated to it. A real implementation would record the dependencies of each proposal (price, discount policy, extras) and compare those.
- Matching a free-text note to a request (a suggestion only) and the audience check are deterministic stand-ins.
- The email provider is a table. Real providers document their own idempotency limits.
- No user interface, no Next.js app, no deployment.

## Layout

```
db/schema.sql           application tables, outbox, wake-ups, fake provider
src/ingest.ts           entry points a Next.js route would call
src/bookings.ts         the only way a booking changes; invalidation in the same transaction
src/proposals.ts        draft, approval, execute() checks
src/wake.ts             wake-up policy and batching
src/outbox.ts           exclusive claim, lease, idempotent send, delivery_unknown
src/agent/              Mastra agent, tools, scripted model
src/worker.ts           the single worker
scenario/               the two-process scenario and its trace export
test/                   node:test suites
```

## Walkthrough script

1. The recommendation above, and the decisions table.
2. The two threads, the internal note and the pending work: `src/ingest.ts`, then the first half of the trace.
3. The booking change, the refused approval and the new revision: `src/bookings.ts`, `executeProposal` in `src/proposals.ts`.
4. What Mastra does and what stays in the application: `src/agent/tools.ts`, `src/worker.ts`.
5. What these tests do not prove, and which decision to check against a real system first.
