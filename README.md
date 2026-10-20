# Booking assistant on Mastra: pending work under a changing booking

Reading page, with the recorded trace and a SQL snapshot after each step: https://theaipipe.com/demos/mastra-pending-work/

A small, runnable answer to one architecture question. Sarah asks for 10% off by email. Maya, a manager, agrees through an internal note. Meanwhile Dev, in a second thread, raises the headcount, and staff update the booking before anyone has approved the reply. What should the assistant do, and which part of that is Mastra's job?

Everything here runs on Postgres with a scripted model: no API key, no model cost. The booking, people and addresses are fictional.

## The recommendation

Keep the booking and each piece of pending work in Postgres, and give Mastra one thread per piece of work under one resource per booking, so nothing that matters lives only in the model's window. Let Mastra suspend and resume the approval; let the application bind each approval to one exact revision, recheck the booking inside `execute()`, and record the email to send in the same transaction.

## Run it

```bash
npm ci
npm run db:up      # Postgres 17.6 on localhost:54329 (docker compose)
npm test           # 58 tests, about a minute; any failure exits with code 1
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

`package-lock.json` is committed. `npm run test:record` keeps the output of a run in [`trace/test-run.txt`](trace/test-run.txt) and exits with the suite's own code. `npm test` runs its scenario replays in a temporary folder and leaves `trace/` untouched; `npm run scenario` rewrites it. [`trace/counter-examples-before-fix.txt`](trace/counter-examples-before-fix.txt) keeps the review's counter-examples failing on the earlier code, before the fixes below.

## Decisions

| Object | Decision |
|---|---|
| Booking | A business entity in Postgres. Its current row is the authority; nothing in memory overrides it. Every mutation of a booking's pending work locks the booking row first. |
| Pending work | One persistent `work_items` row per active request, identified by the conversation it started in plus an explicit request key (one open work item per pair, enforced by a unique index). It holds its status, linked sources and what it waits for. |
| Source conversations | Email threads, notes and transcripts keep their ids, authors and audience. A message from another conversation reaches a work item only when it is linked to it (`work_sources`, with the reason). |
| Mastra context | One resource per booking in its organisation (`org_1:booking:B-1042`), one thread per work item (`work:W1`, `work:W2`). `readWorkContext` returns the linked sources and the status of sibling work items, never another thread's history. Memory here uses neither working memory nor semantic recall at resource scope: the resource id groups the threads, and shared state lives in the application tables. Turning resource-scoped memory on later would have to respect audiences. This split is an architecture choice, not something Mastra imposes. |
| Mastra execution | One run per wake-up; an approval resumes the suspended run; several runs can belong to one work item. A runId is never the business identity of anything. |
| Internal decisions | Authority comes from the session (same organisation, right role) and from the note box's controls (approve or decline, and the percentage). The text is evidence only. A new decision replaces the previous one and invalidates the proposals built on it, in one transaction. |
| Proposal | A versioned set of changes plus the reply, its recipients and the evidence it rests on. Only the latest revision of a work item can be approved or executed. Its booking version is the one the model was given (`context_reads`, written by `readWorkContext`); if the booking or the decision moved since that read, the draft is refused and the model reads again. |

## What Mastra does, what the application does

**Mastra** suspends the `submitProposal` tool call (`requireApproval: true`), persists the suspended run in Postgres through `@mastra/pg`, and resumes or declines it later, from another process if needed (`approveToolCallGenerate`, `declineToolCallGenerate`, `listSuspendedRuns`). Memory gives each work item its own thread. `beforeApproval` (new in 1.78.0) rejects a proposal that is already unusable before a person sees it.

Drafting and submitting are two tools on purpose: the application can refuse a draft (an internal note repeated, a wrong recipient, a total that does not match, a stale read) and let the model correct it before anything suspends for a person.

**The application** owns everything that must still be true at execution time:

- Two separate agreements. A manager authorises a discount with a defined scope (`discount_authorizations`, one current decision per request). A person approves one exact proposal revision (`approvals`, bound to a content hash of text, recipients, effects and booking version). A regenerated draft is a new revision and needs a new approval.
- `beforeApproval` is not re-run on resume. The 1.78.0 typings say so: "Not run on resume, so keep validating inside `execute` if state can change while paused." So `execute()` locks the booking, then the proposal and the authorisation, and checks the version, the active revision, the content hash, the current decision and the approver's rights. Only when every check passes does it consume the approval, apply the change and insert the intent to send, in one transaction. A refusal leaves the approval unconsumed and puts the work item back to waiting.
- Two things observed on 1.78.0 while building this. `beforeApproval` receives `requestContext` as a plain object, while `execute` receives a `RequestContext`. And per the typings, "If the hook throws, the error is logged and the call continues to the approval gate." The whole hook is therefore wrapped: when validation cannot run, the call is refused, not shown.
- Also observed on 1.78.0 with `@mastra/pg`: a second concurrent resume of the same run is rejected by Mastra (`AGENT_RESUME_ALREADY_CLAIMED`, or "could not find a suspended run" once the first has finished). The application does not rely on it. Mastra's durable-agents page warns that recovery can re-execute tool calls, so the action key comes from the proposal revision (`send-reply:W1-r2`), not from the run.
- Wake-ups are delivered at least once: a worker claims a row under a lease and deletes it only after the run reached a durable result. If Mastra suspended a run but the process died before the application linked it to its proposal, the next wake-up finds the run in Mastra's storage and links it instead of drafting again.

## The scenario

`npm run scenario` replays this in two OS processes. The full trace with every row is in [`trace/scenario-trace.md`](trace/scenario-trace.md), and `trace/scenario-trace.json` holds a SQL snapshot after each step.

1. 09:02 Thread A, Sarah asks for 10%. Work item W1 opens on thread `work:W1`, waits for a manager decision.
2. 09:10 Thread B, Dev says they will be 10, not 8. W2 opens on `work:W2` (same resource), waits for the booking to be updated.
3. 09:25 Maya, a manager (identity from the session), approves up to 10% with the controls of W1's note box and adds a reason in the text: an explicit link and an authorisation for W1 only.
4. 09:25 W1 reads the booking (v1, 8 guests, £800.00) and drafts W1-r1: £720.00 to Sarah. Mastra suspends for approval.
5. 09:31 Tom changes the guests to 10 in the CRM: booking v2, £1,000.00. W1-r1 is invalidated in the same transaction. Declining its suspended call makes one short closing call to the (scripted) model; the redraft itself waits for the batch window.
6. 09:32 Tom clicks approve on W1-r1 from a stale screen: refused.
7. 09:32:30 Tom edits the title (v3): the wake-up is pushed back, the two edits are grouped. A contact phone edit wakes nothing.
8. 09:34:30 One wake-up each. W1 drafts W1-r2 on v3: £900.00. Of W1's three wake-ups, the model's window now holds two; the request, the decision and the booking come from Postgres through `readWorkContext`. W2 sees 10 guests and closes; this prototype models a reply under approval for W1 only.
9. Process 1 exits. A fresh process 2 reloads the suspended run and the persisted thread state from Postgres.
10. 09:51 Tom double-clicks approve on W1-r2: one approval. The run resumes; `execute()` finds v3 unchanged, consumes the approval, applies 10% (v4, provenance `assistant`, which wakes nothing) and records `send-reply:W1-r2`.
11. 09:51:12 The outbox worker claims the action; the provider accepts it with the action key as idempotency key; the reply lands in thread A; W1 is done.

The scenario shows a late click on an invalidated proposal. The case "approved, then the booking changed before execution" is a separate test (below).

## Tests, and exactly what each family proves

| Family | Proves | Does not prove |
|---|---|---|
| Stale proposals (6) | An invalidated proposal cannot be approved; approved then booking changed: `execute()` refuses and a new revision waits; a version bump made by raw SQL is caught; edits to text, recipients or effects after approval never reuse it; `beforeApproval` refuses a stale draft; a revoked authorisation refuses without consuming the approval | A raw write that does not bump `version` |
| Review counter-examples (22, `test/counter-examples.test.ts`) | A later 5% decision stops an approved 10% proposal; a decline during execution waits for the booking lock; a wake-up or a deadline claimed by a process killed with SIGKILL is processed by the next one; a crash between Mastra's suspension and the application's link is reconciled; an approved revision cannot run once a newer one exists; a draft written from a read the booking has moved past is refused; managers from another organisation can neither authorise nor approve, and `execute()` rechecks the approver; a CRM edit during execution does not deadlock; two messages at once in one thread make one work item, an explicitly separate request makes two; a subject line repeating a note is rejected; re-approving after an invalidation reports it; an urgent wake-up stays urgent; a refusal never leaves the work item parked; an immediate redraft leaves no phantom wake-up; a superseded outbox attempt cannot acknowledge; a failure while recording the send rolls back the approval and the booking change; an error inside `beforeApproval` refuses the call; one worker tick resumes and sends | Interleavings other than the ones forced by the test pauses |
| Duplicate actions (6) | Double click gives one approval; two executions of one proposal give one action keyed on the revision; Mastra 1.78.0 rejects a second concurrent resume; two worker processes send once; a SIGKILL after the provider accepted gives one email with an idempotency key, and `delivery_unknown` without one | Any real provider's idempotency window |
| Notes and intake (9) | Explicit reference with a structured decision; a decline withdraws earlier authorisations; the recorded amount is the decided one (5, 12.5), never read from text; text alone authorises nothing; free references only suggest; ambiguous notes ask; a customer's claim and a coordinator's note authorise nothing; work item ids come from a sequence | How well a real model matches free text |
| Audience and scope (4) | The note is evidence, not reply text; a reply repeating five consecutive words of an internal note is rejected; recipients outside the request's external threads are rejected; a tool call naming another work item is refused | Paraphrases of a note |
| Restart (1) | Process 1 suspends and exits, process 2 (another PID, same database) finds the run and executes once | A crash in the middle of a Mastra run (the durable-agents recovery path, not used here) |
| Wake-ups and batching (7) | Wake now for requests and decisions; invalidation at once, redraft after the window; one wake-up per burst, capped at 10 min; nothing for unrelated edits or the assistant's own events; deadlines | Tuning for real traffic |
| End to end (3) | The scenario's order of steps and final state, two processes, two Mastra threads under one resource; the same reply and hash under `TZ=Asia/Dubai` and `TZ=America/Los_Angeles` | |

## Wake-up rules

| Event | Behaviour |
|---|---|
| New explicit request | Create or find the work item (atomically), wake now |
| Human decision linked to a request | Wake now; stays due now even if ordinary edits follow |
| Change to a dependency of a pending proposal | Invalidate the proposal in the same transaction; redraft after the batch window |
| Series of ordinary edits | One wake-up after 2 min of quiet, at most 10 min after the first |
| Edit unrelated to open work | Nothing |
| Event produced by the assistant | Recognised by provenance and action key; never wakes the work that caused it |
| Deadline reached | Becomes a wake-up row, then follows the same claim and acknowledgement |

An old draft stops being executable at once; the model is called for the redraft only after the batch window. Declining the old suspended call is one short closing call.

## Mastra facilities: kept, deferred, and when to bring them in

Checked against the docs shipped inside `@mastra/core@1.78.0` (`node_modules/@mastra/core/dist/docs/references/`).

| Facility | Here | Why | Bring it in when |
|---|---|---|---|
| Tool approval (`requireApproval`, `beforeApproval`, approve/decline) | Used | The pause for a human is Mastra's job | |
| Memory: resource and thread | Used | One thread per work item under one resource per booking | |
| `@mastra/pg` storage | Used | Same Postgres as the app, schema `mastra` | |
| Signals (added in 1.39.0) and state signals | Deferred | Runs here are short; wake-ups are rows the web app writes and one worker consumes | A run lasts long enough that a new email should reach it mid-run |
| Notification signals, priority-aware delivery with summaries | Deferred | Batching here depends on business rules (dependency or not) and must commit with the invalidation | Low-stakes events (FYI edits, mentions) that the agent can read in bulk |
| Schedules (added in 1.50.0, persisted, cron) | Deferred | A deadline is one column on the work item, turned into a wake-up by the worker | Recurring work such as a daily digest of open requests |
| Multi-user threads | Not used | Speakers are carried as sources with server-side authors | Staff and the assistant share one conversation thread |
| PubSub: Redis Streams, Unix socket, Google Cloud Pub/Sub | Not used | One persistent worker; the default in-memory pub/sub is enough inside one process | Several workers must share the same active threads. Redis Streams gives cross-instance delivery and leases; the Unix socket transport covers several processes on one host; Google Cloud Pub/Sub crosses hosts without leases |

Starting point: Next.js routes record inputs in Postgres (`src/ingest.ts` is what they would call), and one long-running Mastra worker consumes them; `workerTick` in `src/worker.ts` is one pass of its loop. No Redis.

## Moving to Supabase

Mastra storage already uses `@mastra/pg`. Point `DATABASE_URL` at the Supabase database, apply `db/schema.sql` as a migration, and give the long-running worker a direct or session-mode connection; routes that only insert events can use the transaction pooler. If a file database is handier for local demos, `@mastra/libsql` (`new LibSQLStore({ id, url: 'file:./mastra.db' })`) can hold Mastra's state; the application tables still need Postgres for the row locks and `SKIP LOCKED`. None of this was run against Supabase here.

## Limits

- The model is scripted (`src/agent/fake-model.ts`): a pure function of the prompt, so it behaves the same after a restart. It proves the mechanisms. How well a real model understands free notes, matches them to requests and writes replies has to be evaluated separately, with a real model.
- One `booking.version` for the whole row is deliberately conservative: any booking edit invalidates a pending proposal, even one unrelated to it.
- Matching a free-text note to a request (a suggestion only) and the audience check (five consecutive words, subject and body) are deterministic stand-ins.
- The email provider is a table. Real providers document their own idempotency limits.
- No user interface, no Next.js app, no deployment.

## Layout

```
db/schema.sql           application tables, outbox, wake-ups, context reads, snapshots, fake provider
src/ingest.ts           entry points a Next.js route would call
src/bookings.ts         lock order, staff checks, the only way a booking changes
src/proposals.ts        draft, approval, execute() checks
src/wake.ts             wake-up policy, batching, claims and acknowledgements
src/outbox.ts           exclusive claim, lease, attempt token, idempotent send, delivery_unknown
src/agent/              Mastra agent, tools, scripted model
src/worker.ts           the single worker and one pass of its loop (workerTick)
scenario/               the two-process scenario, its trace and SQL snapshots
test/                   node:test suites
```

## Where to read first

1. The recommendation above, and the decisions table.
2. The two threads, the internal note and the pending work: `src/ingest.ts`, then the first half of the trace.
3. The booking change, the refused approval and the new revision: `src/bookings.ts`, `executeProposal` in `src/proposals.ts`.
4. What Mastra does and what stays in the application: `src/agent/tools.ts`, `src/worker.ts`.
5. Two decisions to settle against a real system:
   - Invalidation granularity. One version per booking invalidates a pending discount when only the logistics changed. Versions or fingerprints per domain (pricing, headcount, logistics), recorded with each proposal's read, would invalidate only what a proposal depends on.
   - The signal from the web app to the worker on Supabase. Next.js routes write the input and its wake-up row through the transaction pooler. The worker keeps one direct or session connection, listens with `LISTEN/NOTIFY` for a prompt wake, and still polls `app.wakeups` on a short interval, since a notification can be missed while it reconnects.
