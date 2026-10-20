-- Application state. Postgres is the source of truth; Mastra keeps its own tables in schema "mastra".
create schema if not exists app;
create schema if not exists provider;

create sequence app.work_item_seq;

create table app.staff (
  id text primary key,
  org_id text not null,
  name text not null,
  email text not null,
  role text not null check (role in ('manager', 'coordinator'))
);

create table app.bookings (
  id text primary key,
  org_id text not null,
  title text not null,
  event_date date not null,
  guests int not null,
  price_per_guest_cents int not null,
  discount_pct numeric not null default 0,
  total_cents int not null,
  status text not null default 'confirmed',
  -- Conservative prototype: one version for the whole row. Any change bumps it.
  version int not null default 1,
  last_change_provenance text,
  last_action_key text
);

create table app.contacts (
  id text primary key,
  org_id text not null,
  booking_id text references app.bookings(id),
  name text not null,
  email text not null,
  phone text
);

-- Email threads, staff notes and transcripts, each with its own id and audience.
create table app.conversations (
  id text primary key,
  org_id text not null,
  booking_id text not null references app.bookings(id),
  channel text not null check (channel in ('email', 'note', 'transcript')),
  subject text not null,
  audience text not null check (audience in ('external', 'internal'))
);

create table app.participants (
  conversation_id text not null references app.conversations(id),
  address text not null,
  name text not null,
  primary key (conversation_id, address)
);

create table app.messages (
  id text primary key,
  conversation_id text not null references app.conversations(id),
  external_id text unique,
  -- author_kind and author_ref come from the server (mail headers, authenticated session), never from the text.
  author_kind text not null check (author_kind in ('customer', 'staff', 'assistant')),
  author_ref text not null,
  body text not null,
  at timestamptz not null
);

-- One persistent object per active request or topic.
create table app.work_items (
  id text primary key,
  org_id text not null,
  booking_id text not null references app.bookings(id),
  kind text not null check (kind in ('discount', 'participants')),
  title text not null,
  status text not null,
  waiting_for text,
  resume_at timestamptz,
  mastra_resource text not null,
  mastra_thread text not null,
  -- Identity of the request: the conversation it started in, and an explicit key when one thread carries
  -- several requests. At most one open work item per pair, enforced by the index below.
  origin_conversation_id text not null references app.conversations(id),
  request_key text not null default 'main',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create unique index work_items_one_open_per_request on app.work_items (origin_conversation_id, request_key) where status <> 'done';

create table app.work_sources (
  work_item_id text not null references app.work_items(id),
  message_id text not null references app.messages(id),
  link text not null check (link in ('origin', 'evidence', 'decision', 'suggested')),
  linked_by text not null,
  reason text not null,
  primary key (work_item_id, message_id)
);

-- First agreement: a manager authorises a discount, with a defined scope.
create table app.discount_authorizations (
  id bigserial primary key,
  work_item_id text not null references app.work_items(id),
  booking_id text not null references app.bookings(id),
  max_pct numeric not null,
  scope text not null,
  granted_by text not null references app.staff(id),
  source_message_id text not null references app.messages(id),
  revoked boolean not null default false,
  at timestamptz not null
);

-- Notes that could not be attached with certainty.
create table app.clarifications (
  id bigserial primary key,
  message_id text not null references app.messages(id),
  candidates text[] not null,
  question text not null,
  status text not null default 'open',
  at timestamptz not null
);

-- A versioned set of changes and communications to approve.
create table app.proposals (
  id text primary key,
  work_item_id text not null references app.work_items(id),
  revision int not null,
  booking_id text not null references app.bookings(id),
  based_on_booking_version int not null,   -- recorded by the application from its own read
  effects jsonb not null,
  reply_to text[] not null,
  reply_subject text not null,
  reply_body text not null,
  evidence text[] not null,
  content_hash text not null,
  status text not null check (status in ('draft', 'pending_approval', 'approved', 'invalidated', 'superseded', 'executed')),
  status_reason text,
  mastra_run_id text,
  mastra_tool_call_id text,
  run_closed boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (work_item_id, revision)
);

-- Second agreement: a person approves one exact proposal revision.
create table app.approvals (
  id bigserial primary key,
  proposal_id text not null unique references app.proposals(id),
  content_hash text not null,
  approved_by text not null references app.staff(id),
  approved_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_action text
);

-- Durable intent to act outside the database. The key does not depend on any Mastra runId.
create table app.actions (
  key text primary key,
  proposal_id text not null references app.proposals(id),
  kind text not null,
  payload jsonb not null,
  status text not null check (status in ('pending', 'claimed', 'sent', 'delivery_unknown')),
  claimed_by text,
  lease_until timestamptz,
  attempts int not null default 0,
  provider_message_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- Every input, whoever produced it. Next.js routes write here; the worker consumes.
create table app.events (
  id bigserial primary key,
  org_id text not null,
  booking_id text,
  kind text not null,
  provenance text not null check (provenance in ('customer', 'staff', 'assistant', 'system')),
  actor text not null,
  action_key text,
  payload jsonb not null default '{}',
  at timestamptz not null
);

-- Debounced wake-ups: one row per work item, pushed back while ordinary edits keep coming.
-- A worker claims a row with a lease and deletes it only after the run reached a durable result;
-- if events arrived meanwhile (event_count moved), the row stays for the next run.
create table app.wakeups (
  work_item_id text primary key references app.work_items(id),
  reasons text[] not null,
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  run_after timestamptz not null,
  urgent boolean not null default false,
  event_count int not null default 1,
  claimed_by text,
  claimed_until timestamptz
);

-- What the application handed the model, so a draft can be tied to the read it was written from.
create table app.context_reads (
  id bigserial primary key,
  work_item_id text not null references app.work_items(id),
  booking_version int not null,
  authorisation_id bigint,
  at timestamptz not null
);

-- SQL snapshots taken by the scenario after each step, for the reading page.
create table app.snapshots (
  seq bigserial primary key,
  label text not null unique,
  at timestamptz not null,
  data jsonb not null
);

create table app.trace (
  seq bigserial primary key,
  at timestamptz not null,
  pid int not null,
  actor text not null,
  kind text not null,
  step text not null,
  detail jsonb not null default '{}'
);

-- Stand-in for an external email provider. Lives outside "app" and survives process crashes.
create table provider.messages (
  id text primary key,
  idempotency_key text unique,
  client_ref text not null,
  to_addr text[] not null,
  subject text not null,
  body text not null,
  accepted_at timestamptz not null default now()
);
