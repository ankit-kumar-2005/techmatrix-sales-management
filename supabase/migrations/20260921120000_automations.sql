-- Automation Workflow Builder — the first feature in this app that
-- creates real business records with nobody watching. Every design
-- decision below follows from that one fact.
--
-- No new tenant model, no new role system, no new hierarchy logic: this
-- migration reuses is_customer_member, is_customer_admin (both from
-- 20260904140000), set_updated_at(), the composite same-customer FK
-- pattern used by tasks/leads/customer_integrations, and the
-- SECURITY DEFINER + caller-supplied-token shape proven by
-- ingest_lead() in 20260919120000.
--
-- =====================================================================
-- DESIGN NOTES
-- =====================================================================
--
-- 1. WHY AN AFTER INSERT TRIGGER ON leads, NOT APPLICATION CODE.
--    Leads are created by exactly two paths in this codebase:
--    features/leads/actions.ts (a Server Action, RLS client) and
--    ingest_lead() (SECURITY DEFINER, called by the webhook with no
--    session). An outbox written from TypeScript would cover the first
--    and silently miss every webhook-captured lead — which is the
--    flagship case this feature exists for. A row-level AFTER INSERT
--    trigger is the only mechanism that is genuinely inside the same
--    transaction as BOTH. Triggers are already the established pattern
--    on this exact table (leads_set_updated_at,
--    leads_protect_owner_id_change, leads_protect_stage_transition).
--
--    CONSEQUENCE, STATED PLAINLY: because the enqueue is transactional,
--    a failure inside it rolls back the lead insert too. That is the
--    correct trade for an outbox (an event must never be lost for a
--    lead that exists), but it does put this trigger on the critical
--    path of lead creation. It is guarded three ways: it does nothing
--    at all unless the tenant has an Active automation, it writes one
--    row with no joins beyond that guard, and it never reads anything
--    a caller supplied.
--
-- 2. WHY THE WORKER AUTHENTICATES WITH A TOKEN.
--    The execution engine runs from a cron Route Handler with NO user
--    session, so auth.uid() is null. In that state getCurrentMembership()
--    cannot work, is_customer_user_visible() returns false, and the
--    tasks INSERT policy evaluates false — `authenticated` is not even
--    the caller; `anon` is, and anon holds no grant on tasks at all.
--    This project has no service-role key and CLAUDE.md Section E keeps
--    it out of the request path, so the privileged step lives in the
--    database behind a fixed signature, exactly as ingest_lead() does.
--
--    Every worker function below therefore takes p_token and verifies
--    it against automation_worker_config before doing anything. Without
--    that check these functions are granted to anon and would let any
--    caller on the internet drain the queue and read other tenants'
--    events. The token is the whole boundary, and it is checked first
--    in every one of them.
--
--    SETUP STEP THIS CREATES: this migration stores NO token. An
--    operator mints one, once, from a SQL console:
--        select public.rotate_automation_worker_token();
--    and copies the returned value into the AUTOMATION_WORKER_TOKEN
--    environment variable. Only its SHA-256 hash is stored, so the
--    plaintext exists nowhere afterwards and cannot be recovered — the
--    same call is also how it is rotated later, with an overlap window
--    so the environment can catch up without downtime.
--
--    CLAIM OWNERSHIP is a second, separate credential, and a narrower
--    one: claiming an event mints a per-claim `claim_token` which that
--    worker must present back before it may finish the event or record a
--    run against it. The worker token says "you are the worker"; the
--    claim token says "you are the worker that still owns THIS event".
--    Both are required, because the first cannot express the second —
--    see automation_events.claim_token for the bug this prevents.
--
-- 3. WHY IMMUTABLE VERSIONS, AND A FOURTH TABLE.
--    An execution that is in flight must be unaffected by an admin
--    editing the workflow at that moment, and run history has to record
--    which definition actually ran. Both need the definition to be
--    immutable once written, so customer_automations holds identity and
--    mutable operational state while customer_automation_versions holds
--    insert-only snapshots. Versions have no UPDATE policy and no UPDATE
--    grant — immutability is a permission, not a convention. Editing an
--    Active automation inserts a new Draft version; the Active version
--    keeps executing until an admin explicitly activates the new one.
--
-- 4. WHY JSONB FOR definition, IN A CODEBASE THAT OTHERWISE DOESN'T.
--    CLAUDE.md Section F names this case directly ("JSONB is for
--    genuinely schema-flexible data (e.g., a free-form automation config
--    blob)"), and the shape here earns it: a workflow graph is authored
--    and replaced wholesale by one admin in one editing session, and
--    nothing in the database ever queries, filters, sorts, joins or
--    constrains its interior. That is the exact inverse of leads/tasks/
--    contacts, which are row-level, concurrently written and queried by
--    their individual fields — which is why those correctly got real
--    columns. Everything here that IS relational (which automation,
--    which version, which event, which run, who was assigned) sits in
--    real columns behind real foreign keys. The graph's interior is
--    validated by Zod against a registry in TypeScript before it is ever
--    stored, and again before it is ever executed.
--
-- 5. WHY tasks.automation_key, AND WHY A PARTIAL UNIQUE INDEX.
--    Directly modelled on leads_external_source_unique from
--    20260919120000 — the same problem (an at-least-once delivery
--    creating the same record twice) solved the same way. The column is
--    nullable because every task created by a human has no automation
--    key, and a partial index means those rows cost nothing and cannot
--    collide with each other.
--
-- 6. LOOP PREVENTION IS ENFORCED BUT NOT REACHABLE IN v1.
--    Events carry root_event_id, correlation_id and depth so that an
--    action which itself triggers an event can be traced to its root and
--    bounded. In v1 the only action is task.create and the only trigger
--    is lead.created — creating a task does not create a lead, so no
--    cycle can actually form. The machinery is real and enforced anyway,
--    because the moment a second trigger exists it becomes reachable,
--    and retrofitting lineage onto an outbox that has already been
--    running is far worse than carrying three columns now.
--
-- 7. NO HARD DELETES ANYWHERE. Automations are deactivated
--    (status = 'Inactive'), matching customer_lead_stages,
--    customer_catalog_items and customer_integrations. No table here has
--    a DELETE policy or a DELETE grant.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Worker authentication (design note 2)
-- ---------------------------------------------------------------------

-- THE TOKEN IS NEVER STORED. Only its SHA-256 hash is, so a database
-- dump, a stray backup, a mistaken future SELECT policy or a support
-- engineer with read access cannot recover a working credential. This is
-- a deliberate departure from customer_integrations.webhook_token, which
-- is stored in plaintext: that token is scoped to ONE tenant and can
-- only push a lead, while this one is a cross-tenant worker credential
-- that can write to any customer's tasks. The blast radius is not
-- comparable, so the storage should not be either.
--
-- ROTATION IS FIRST-CLASS, not an afterthought. Rotating a single-value
-- secret means there is always a window where the stored value and the
-- deployed environment variable disagree and every automation is broken.
-- So a previous hash stays valid for an overlap window: rotate, deploy
-- the new value, and the old one keeps working until the window closes.
create table public.automation_worker_config (
  id boolean primary key default true,
  token_hash text not null,
  -- The hash being retired. Valid until previous_expires_at, so a
  -- rotation does not require the database and the environment to change
  -- in the same instant.
  previous_token_hash text,
  previous_expires_at timestamptz,
  rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- Singleton: `id` is a boolean defaulting to true, so a second row is
  -- a primary key violation rather than something to police in code.
  -- There is exactly one worker identity for this deployment.
  constraint automation_worker_config_singleton check (id is true),
  constraint automation_worker_config_hash_length check (length(token_hash) = 64),
  constraint automation_worker_config_previous_hash_length
    check (previous_token_hash is null or length(previous_token_hash) = 64),
  -- A retiring hash without an expiry would never stop being valid.
  constraint automation_worker_config_previous_needs_expiry
    check ((previous_token_hash is null) = (previous_expires_at is null))
);

-- DELIBERATELY NOT SEEDED. There is no plaintext to store, and a
-- generated token nobody ever saw would be useless. The table starts
-- empty, verify_automation_worker returns false for everything, and the
-- engine fails closed with a message naming the exact setup step. The
-- token comes into existence when an operator runs
-- rotate_automation_worker_token() and is shown it once.
--
-- RLS on, and deliberately ZERO policies: no role can read this row
-- through the API at all. The only code that needs it is a SECURITY
-- DEFINER function running as the table owner, which bypasses RLS.
alter table public.automation_worker_config enable row level security;
revoke all on public.automation_worker_config from public, anon, authenticated;

/**
 * Generates a new worker token, stores only its hash, and returns the
 * plaintext ONCE. There is no second chance to read it.
 *
 *   select public.rotate_automation_worker_token();
 *
 * The outgoing hash stays valid for p_overlap so the environment can be
 * updated without downtime. Pass interval '0' to revoke immediately —
 * which is what a suspected leak calls for.
 *
 * NOT CALLABLE THROUGH THE API. Revoked from public/anon/authenticated
 * below; it runs from a SQL console as the table owner only.
 *
 * gen_random_uuid() rather than pgcrypto's gen_random_bytes(): it is a
 * core function, so it resolves under `search_path = public` on any
 * deployment. sha256() is core too (PostgreSQL 11+). Neither depends on
 * where the pgcrypto extension happens to be installed — which on
 * Supabase is the `extensions` schema, and would NOT be found from a
 * function with a pinned search_path.
 */
create or replace function public.rotate_automation_worker_token(
  p_overlap interval default interval '1 hour'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_hash text;
  v_old_hash text;
begin
  -- 64 hex characters from two UUIDs, the same construction
  -- customer_integrations.webhook_token uses.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_hash := encode(sha256(v_token::bytea), 'hex');

  select token_hash into v_old_hash from public.automation_worker_config where id is true;

  insert into public.automation_worker_config (id, token_hash, previous_token_hash, previous_expires_at, rotated_at)
  values (
    true,
    v_hash,
    case when v_old_hash is not null and p_overlap > interval '0' then v_old_hash end,
    case when v_old_hash is not null and p_overlap > interval '0' then now() + p_overlap end,
    now()
  )
  on conflict (id) do update
    set token_hash = excluded.token_hash,
        previous_token_hash = excluded.previous_token_hash,
        previous_expires_at = excluded.previous_expires_at,
        rotated_at = excluded.rotated_at;

  return v_token;
end;
$$;

create or replace function public.verify_automation_worker(p_token text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  -- Length-guarded before hashing so a null or obviously-wrong argument
  -- cannot reach the comparison.
  --
  -- NOT CONSTANT-TIME, and that is acceptable here for a reason rather
  -- than by omission: the comparison is against a SHA-256 digest of the
  -- caller's input, so a timing difference leaks information about the
  -- hash of a guess, not about the token. Recovering the token from that
  -- would require inverting SHA-256. The function is also not callable
  -- by any API role (see the revoke below), so there is no remote path
  -- to time it at all.
  select exists (
    select 1
    from public.automation_worker_config c
    where p_token is not null
      and length(p_token) >= 32
      and (
        c.token_hash = encode(sha256(p_token::bytea), 'hex')
        or (
          c.previous_token_hash = encode(sha256(p_token::bytea), 'hex')
          and c.previous_expires_at > now()
        )
      )
  );
$$;

-- ---------------------------------------------------------------------
-- tasks.automation_key — idempotency (design note 5)
-- ---------------------------------------------------------------------

alter table public.tasks add column automation_key text;

comment on column public.tasks.automation_key is
  'Deterministic idempotency key for a task created by an automation; null for every human-created task. See automation_key composition in features/automations/lib/idempotency.ts.';

create unique index tasks_automation_key_unique
  on public.tasks (customer_id, automation_key)
  where automation_key is not null;

-- WHICH AUTOMATION MADE THIS TASK — a real column with a real foreign
-- key, added because automation_key happens to CONTAIN the automation id
-- and answering "where did this task come from?" by substring-parsing an
-- idempotency key is not a relationship, it is a guess that happens to
-- work. The FK is added after customer_automations exists, further down.
alter table public.tasks add column automation_id uuid;

comment on column public.tasks.automation_id is
  'The automation that created this task; null for every human-created task. Paired with customer_id by a composite FK, so a task can never cite another tenant''s automation.';

create index tasks_automation_id_idx on public.tasks (automation_id)
  where automation_id is not null;

-- ---------------------------------------------------------------------
-- customer_automations — identity + mutable operational state
-- ---------------------------------------------------------------------

create table public.customer_automations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'Draft' check (status in ('Draft', 'Active', 'Inactive')),
  -- Which immutable version the engine must run. Null while the
  -- automation has never been activated. FK added after the versions
  -- table exists (the two reference each other).
  active_version_id uuid,
  -- How this automation came into existence. RECORDED FOR HISTORY ONLY —
  -- nothing in the execution path, in any safeguard, or in any policy
  -- reads it. An AI-authored automation and a hand-built one are the
  -- same row to every line of code that runs after activation, and this
  -- column exists so that stays auditable rather than unknowable.
  origin text not null default 'Manual' check (origin in ('Manual', 'AI')),
  -- Round-robin rotation cursor. Mutable operational state, so it lives
  -- here and not on the immutable version: a rotation advancing is not
  -- an edit to the workflow.
  last_assigned_to uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_automations_name_not_blank check (btrim(name) <> ''),
  constraint customer_automations_customer_id_key unique (customer_id, id),
  constraint customer_automations_last_assigned_same_customer_fkey
    foreign key (customer_id, last_assigned_to)
    references public.customer_users (customer_id, id)
    on delete set null (last_assigned_to),
  -- An Active automation with no version to run is not a state the
  -- engine should ever have to interpret.
  constraint customer_automations_active_needs_version
    check (status <> 'Active' or active_version_id is not null)
);

create index customer_automations_customer_id_idx on public.customer_automations (customer_id);
create index customer_automations_status_idx on public.customer_automations (customer_id, status);

create trigger customer_automations_set_updated_at
  before update on public.customer_automations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- customer_automation_versions — immutable snapshots (design note 3)
-- ---------------------------------------------------------------------

create table public.customer_automation_versions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  automation_id uuid not null,
  version integer not null check (version > 0),
  -- Denormalized out of `definition` on purpose, and the one exception
  -- to design note 4: the engine matches an incoming event against this
  -- column in SQL, so it has to be a real indexed column rather than a
  -- JSON path. Plain text with no CHECK — the TypeScript trigger
  -- registry is the authority on which values exist, the same call
  -- customer_integrations.source made for the same reason (a new
  -- trigger type must not require a migration).
  trigger_type text not null,
  definition jsonb not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint customer_automation_versions_trigger_not_blank check (btrim(trigger_type) <> ''),
  constraint customer_automation_versions_definition_is_object
    check (jsonb_typeof(definition) = 'object'),
  constraint customer_automation_versions_customer_id_key unique (customer_id, id),
  constraint customer_automation_versions_automation_same_customer_fkey
    foreign key (customer_id, automation_id)
    references public.customer_automations (customer_id, id)
    on delete cascade,
  constraint customer_automation_versions_number_unique unique (automation_id, version)
);

create index customer_automation_versions_automation_idx
  on public.customer_automation_versions (automation_id, version desc);
create index customer_automation_versions_customer_id_idx
  on public.customer_automation_versions (customer_id);

alter table public.customer_automations
  add constraint customer_automations_active_version_same_customer_fkey
    foreign key (customer_id, active_version_id)
    references public.customer_automation_versions (customer_id, id)
    on delete set null (active_version_id);

-- Now that customer_automations exists, tie tasks.automation_id to it
-- COMPOSITELY. This is defence in depth for the tenancy check inside
-- create_automation_task: even if that check were removed or bypassed, a
-- task citing another tenant's automation is a constraint violation, not
-- a row.
--
-- ON DELETE RESTRICT rather than CASCADE — deleting an automation must
-- never delete the tasks it created, and automations are never
-- hard-deleted in this app anyway (design note 7), so this is a
-- theoretical backstop kept consistent with tasks_assigned_to's own
-- restrict.
alter table public.tasks
  add constraint tasks_automation_same_customer_fkey
    foreign key (customer_id, automation_id)
    references public.customer_automations (customer_id, id)
    on delete restrict;

-- ---------------------------------------------------------------------
-- automation_events — the transactional outbox (design notes 1, 6)
-- ---------------------------------------------------------------------

create table public.automation_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  -- Plain text, no CHECK — same reasoning as trigger_type above.
  event_type text not null,
  -- The record the event is about. For lead.created this is a lead id.
  -- Deliberately NOT a foreign key: an event is a historical fact that
  -- must survive its subject, and a hard FK here would make the outbox
  -- an obstacle to deleting anything.
  subject_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  /**
   * WHO CURRENTLY OWNS THIS CLAIM. Freshly generated every time the row
   * is claimed, handed to that worker alone, and required back before
   * the worker is allowed to finish the event or record a run against it.
   *
   * WHY IT EXISTS — a bug this replaced, reproduced against a real
   * PostgreSQL before the fix: a worker whose claim had gone stale (a
   * serverless timeout, a redeploy mid-run) could still call
   * complete_automation_event and the UPDATE would match, because the
   * only condition was `status = 'processing'`. The event was marked
   * succeeded WHILE A SECOND WORKER WAS STILL RUNNING IT, so a genuine
   * failure could be recorded as a success, and a `failed` report from
   * the zombie could resurrect an event the live worker was about to
   * finish. Status alone cannot express ownership; this can.
   */
  claim_token uuid,
  processed_at timestamptz,
  last_error text,
  -- Lineage (design note 6). root_event_id is filled by the BEFORE
  -- INSERT trigger below to this row's own id when the caller does not
  -- supply one, which is what makes "the event that started all of
  -- this" answerable from any descendant without a recursive walk.
  -- NOT NULL is safe despite being filled by a trigger: a BEFORE INSERT
  -- trigger runs before constraints are checked, so the trigger below has
  -- always set this by the time NOT NULL is evaluated. Declaring it means
  -- a future insert path that somehow bypassed the trigger would fail
  -- loudly rather than silently produce an event with no lineage.
  root_event_id uuid not null,
  correlation_id uuid not null default gen_random_uuid(),
  depth integer not null default 0 check (depth >= 0),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint automation_events_event_type_not_blank check (btrim(event_type) <> ''),
  constraint automation_events_payload_is_object check (jsonb_typeof(payload) = 'object'),
  -- A claimed row must say when it was claimed AND who owns the claim,
  -- or stale recovery has nothing to measure against and ownership
  -- cannot be checked.
  constraint automation_events_processing_has_claim
    check (status <> 'processing' or (claimed_at is not null and claim_token is not null)),
  -- Lets customer_automation_runs reference an event COMPOSITELY, by
  -- (customer_id, event_id) — see that table's own note. Purely
  -- additive alongside the primary key.
  constraint automation_events_customer_id_key unique (customer_id, id)
);

-- The claim query's index: partial, so it stays the size of the BACKLOG
-- rather than the size of all history. An outbox that has processed a
-- million events still has a handful of pending ones, and this index
-- only ever contains those.
create index automation_events_pending_idx
  on public.automation_events (created_at)
  where status = 'pending';

-- Stale recovery scans only in-flight rows, for the same reason.
create index automation_events_processing_idx
  on public.automation_events (claimed_at)
  where status = 'processing';

create index automation_events_customer_id_idx on public.automation_events (customer_id);
create index automation_events_root_idx on public.automation_events (root_event_id);
create index automation_events_subject_idx on public.automation_events (subject_id);

create or replace function public.set_automation_event_root()
returns trigger
language plpgsql
-- Pinned even though this is SECURITY INVOKER and touches no table:
-- every function in this migration pins it, so there is no function here
-- whose resolution depends on the caller's search_path.
set search_path = public
as $$
begin
  -- A root event is its own root. Done in a trigger rather than as a
  -- column DEFAULT because a default cannot reference the row's own
  -- generated id.
  if new.root_event_id is null then
    new.root_event_id := new.id;
  end if;
  return new;
end;
$$;

create trigger automation_events_set_root
  before insert on public.automation_events
  for each row execute function public.set_automation_event_root();

-- ---------------------------------------------------------------------
-- customer_automation_runs — execution history
-- ---------------------------------------------------------------------

create table public.customer_automation_runs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  automation_id uuid not null,
  -- Which definition actually ran. NOT NULL and immutable, so history
  -- can never say "this ran" without being able to say what "this" was.
  version_id uuid not null,
  /**
   * COMPOSITE, not a plain FK to automation_events(id).
   *
   * A plain reference let a run claim customer_id = A while citing an
   * event that belonged to customer B — reproduced against a real
   * PostgreSQL before this was tightened. Nothing was leaked by it, but
   * the audit trail could be made to say a tenant had done something
   * they never did, and run history is the only account this feature can
   * give of itself. Pairing customer_id with event_id makes that
   * combination a constraint violation rather than an application
   * convention.
   */
  event_id uuid not null,
  root_event_id uuid not null,
  correlation_id uuid not null,
  status text not null
    check (status in ('succeeded', 'failed', 'skipped', 'stopped_by_safeguard')),
  -- Why a run stopped short. Required for exactly the two statuses that
  -- are meaningless without it — a safeguard stop that does not say
  -- which safeguard fired is the failure mode this column exists to
  -- prevent.
  stop_reason text,
  error_detail text,
  actions_executed integer not null default 0 check (actions_executed >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint customer_automation_runs_automation_same_customer_fkey
    foreign key (customer_id, automation_id)
    references public.customer_automations (customer_id, id)
    on delete cascade,
  constraint customer_automation_runs_version_same_customer_fkey
    foreign key (customer_id, version_id)
    references public.customer_automation_versions (customer_id, id)
    on delete cascade,
  constraint customer_automation_runs_event_same_customer_fkey
    foreign key (customer_id, event_id)
    references public.automation_events (customer_id, id)
    on delete cascade,
  -- THE RUN-LEVEL IDEMPOTENCY GUARANTEE: one automation can produce at
  -- most one run per event, whatever happens upstream — a retry, two
  -- workers racing, a redelivered webhook. The task-level key in
  -- tasks.automation_key is the second, independent layer (design note
  -- 5); these two fail differently and neither substitutes for the
  -- other.
  constraint customer_automation_runs_once_per_event unique (automation_id, event_id),
  constraint customer_automation_runs_safeguard_has_reason
    check (status <> 'stopped_by_safeguard' or btrim(coalesce(stop_reason, '')) <> '')
);

create index customer_automation_runs_customer_id_idx on public.customer_automation_runs (customer_id);
create index customer_automation_runs_automation_idx
  on public.customer_automation_runs (automation_id, started_at desc);
create index customer_automation_runs_root_idx on public.customer_automation_runs (root_event_id);
create index customer_automation_runs_event_idx on public.customer_automation_runs (event_id);

-- ---------------------------------------------------------------------
-- The outbox write point (design note 1)
-- ---------------------------------------------------------------------

create or replace function public.enqueue_lead_created_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- SECURITY DEFINER so this works identically whether the insert came
  -- from a Server Action (as `authenticated`) or from ingest_lead() (as
  -- `anon`), neither of which holds any grant on automation_events.
  --
  -- The guard is not an optimization, it is the blast-radius control
  -- described in design note 1: a tenant who has never built an
  -- automation gets no extra write on lead creation at all, so this
  -- trigger cannot affect them in any way.
  if exists (
    select 1
    from public.customer_automations a
    where a.customer_id = new.customer_id
      and a.status = 'Active'
      and a.active_version_id is not null
  ) then
    insert into public.automation_events (customer_id, event_type, subject_id, payload)
    values (
      new.customer_id,
      'lead.created',
      new.id,
      -- A SNAPSHOT of the trigger-relevant facts as they were at
      -- creation. The engine re-reads the lead when it runs, but it
      -- evaluates trigger filters against this snapshot: an admin's
      -- "only IndiaMART leads" rule has to mean "the lead arrived from
      -- IndiaMART", not "the lead's source column still says IndiaMART
      -- by the time a worker got to it".
      jsonb_build_object(
        'source', new.source,
        'owner_id', new.owner_id,
        'stage_id', new.stage_id
      )
    );
  end if;

  return new;
end;
$$;

create trigger leads_enqueue_automation_event
  after insert on public.leads
  for each row execute function public.enqueue_lead_created_event();

-- ---------------------------------------------------------------------
-- Worker RPCs — every one of them token-gated (design note 2)
-- ---------------------------------------------------------------------

-- Claim a bounded batch of pending events, recovering stale ones and
-- retiring exhausted ones on the way in. One round trip, because all
-- three of those need to agree about what "pending" means at a single
-- instant.
create or replace function public.claim_automation_events(
  p_token text,
  p_batch_size integer,
  p_timeout_seconds integer,
  p_max_attempts integer
)
returns setof public.automation_events
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.verify_automation_worker(p_token) then
    -- Silence, not an error: an unauthenticated caller learns nothing
    -- about whether there was anything to claim.
    return;
  end if;

  -- Every limit here is a PARAMETER, never a literal. The single source
  -- of truth for all of them is features/automations/config/safeguards.ts
  -- and these functions are deliberately incapable of holding an opinion
  -- of their own about any of them.
  if p_batch_size is null or p_batch_size < 1
     or p_timeout_seconds is null or p_timeout_seconds < 1
     or p_max_attempts is null or p_max_attempts < 1 then
    raise exception 'claim_automation_events requires positive batch size, timeout and attempt limits.';
  end if;

  -- 1. STALE RECOVERY. A worker that was killed mid-flight (a serverless
  --    timeout, a redeploy) leaves rows stuck in `processing` with no
  --    lock held. Anything claimed longer ago than the timeout is
  --    returned to the queue. attempts was already incremented when it
  --    was claimed, so a row that keeps dying cannot loop forever.
  -- claim_token is CLEARED here, which is what actually revokes the
  -- previous owner: from this moment its completion no longer matches
  -- and is refused rather than silently overwriting whoever picks the
  -- row up next.
  update public.automation_events
     set status = 'pending',
         claimed_at = null,
         claim_token = null,
         last_error = 'Reclaimed after exceeding the processing timeout.'
   where status = 'processing'
     and claimed_at < now() - make_interval(secs => p_timeout_seconds);

  -- 2. RETIREMENT. Past the retry limit an event stops being retried and
  --    becomes visible history instead of silent churn.
  update public.automation_events
     set status = 'dead',
         processed_at = now(),
         last_error = coalesce(last_error, 'Exceeded the retry limit.')
   where status = 'pending'
     and attempts >= p_max_attempts;

  -- 3. CLAIM. FOR UPDATE SKIP LOCKED is what makes two workers running
  --    at once safe: the second one steps over rows the first has
  --    locked instead of blocking on them or double-processing them.
  return query
  with candidate as (
    select e.id
      from public.automation_events e
     where e.status = 'pending'
       and e.attempts < p_max_attempts
     order by e.created_at
     for update skip locked
     limit p_batch_size
  )
  update public.automation_events e
     set status = 'processing',
         claimed_at = now(),
         -- A FRESH OWNERSHIP TOKEN PER CLAIM. Returned to the caller in
         -- the row below and required back by
         -- complete_automation_event/record_automation_run.
         claim_token = gen_random_uuid(),
         attempts = e.attempts + 1
    from candidate c
   where e.id = c.id
  returning e.*;
end;
$$;

-- The active automations a claimed event might match. Returns only what
-- the engine needs, for one tenant at a time, so a worker processing
-- Customer A's event never holds Customer B's definitions in memory.
create or replace function public.get_active_automations(
  p_token text,
  p_customer_id uuid,
  p_trigger_type text
)
returns table (
  automation_id uuid,
  version_id uuid,
  version integer,
  name text,
  trigger_type text,
  definition jsonb,
  last_assigned_to uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.verify_automation_worker(p_token) then
    return;
  end if;

  return query
  select a.id,
         v.id,
         v.version,
         a.name,
         v.trigger_type,
         v.definition,
         a.last_assigned_to
    from public.customer_automations a
    join public.customer_automation_versions v
      on v.id = a.active_version_id
     and v.customer_id = a.customer_id
   where a.customer_id = p_customer_id
     and a.status = 'Active'
     and v.trigger_type = p_trigger_type
   order by a.created_at, a.id;
end;
$$;

-- Lineage for one root event, for the loop safeguards (design note 6).
-- Both answers come from one query because they are read together and
-- must describe the same instant.
create or replace function public.get_automation_lineage(
  p_token text,
  p_root_event_id uuid
)
returns table (
  actions_executed integer,
  automation_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.verify_automation_worker(p_token) then
    return;
  end if;

  return query
  select coalesce(sum(r.actions_executed), 0)::integer,
         coalesce(array_agg(distinct r.automation_id), array[]::uuid[])
    from public.customer_automation_runs r
   where r.root_event_id = p_root_event_id;
end;
$$;

-- Release a claimed event. `p_retryable` decides whether a failure goes
-- back to the queue or is retired immediately: a malformed definition
-- will be malformed on every retry, and retrying it would just burn the
-- attempt budget of an event that can never succeed.
create or replace function public.complete_automation_event(
  p_token text,
  p_event_id uuid,
  p_claim_token uuid,
  p_status text,
  p_error text,
  p_retryable boolean
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_status text;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  if p_claim_token is null then
    -- A caller with no claim token owns nothing. Refused outright rather
    -- than falling through to an UPDATE whose ownership predicate would
    -- then be comparing against NULL.
    return 'not_claimed';
  end if;

  if p_status not in ('succeeded', 'failed') then
    raise exception 'complete_automation_event expects succeeded or failed, got %.', p_status;
  end if;

  if p_status = 'succeeded' then
    v_next_status := 'succeeded';
  elsif p_retryable is true then
    -- Back to pending; claim_automation_events retires it once attempts
    -- reach the limit, so the decision to stop retrying lives in exactly
    -- one place rather than being duplicated here.
    v_next_status := 'pending';
  else
    v_next_status := 'dead';
  end if;

  update public.automation_events
     set status = v_next_status,
         claimed_at = case when v_next_status = 'pending' then null else claimed_at end,
         -- Ownership ends with the claim, whichever way it ended. Left
         -- set on a terminal status purely as a record of which claim
         -- closed it.
         claim_token = case when v_next_status = 'pending' then null else claim_token end,
         processed_at = case when v_next_status = 'pending' then null else now() end,
         -- Truncated: this is written from a caught exception, and an
         -- error string is the one field here that could carry echoed
         -- input.
         last_error = left(nullif(btrim(coalesce(p_error, '')), ''), 500)
   where id = p_event_id
     and status = 'processing'
     -- THE OWNERSHIP CHECK. Without this clause a worker whose claim had
     -- already been reclaimed could still close the event out from under
     -- the worker now running it.
     and claim_token = p_claim_token;

  if not found then
    -- Already released, or reclaimed by stale recovery while this worker
    -- was still running, or this worker never owned it. All three mean
    -- the same thing to the caller: your write did not land, and must
    -- not be assumed to have.
    return 'not_claimed';
  end if;

  return 'ok';
end;
$$;

-- Record one run. The unique (automation_id, event_id) constraint is the
-- real guarantee; ON CONFLICT turns a losing race into a reported
-- duplicate instead of an exception the worker has to interpret.
create or replace function public.record_automation_run(
  p_token text,
  p_customer_id uuid,
  p_automation_id uuid,
  p_version_id uuid,
  p_event_id uuid,
  p_claim_token uuid,
  p_root_event_id uuid,
  p_correlation_id uuid,
  p_status text,
  p_stop_reason text,
  p_error_detail text,
  p_actions_executed integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  -- A caller with no claim token owns nothing.
  --
  -- CHECKED SEPARATELY, AND NOT FOLDED INTO THE PREDICATE BELOW, because
  -- the obvious way to write that predicate is wrong. This check was
  -- originally `e.claim_token is not distinct from p_claim_token`, which
  -- is NULL-SAFE equality: it returns TRUE when BOTH sides are NULL. An
  -- unclaimed event has claim_token = NULL, so passing p_claim_token =
  -- NULL matched it, and run history could be written against an event
  -- nobody was processing. Reproduced against a real PostgreSQL:
  -- test/db/exploit-claim-null.mjs.
  if p_claim_token is null then
    return 'not_claimed';
  end if;

  -- OWNERSHIP, TENANCY AND LIVENESS, ALL THREE.
  --
  --   customer_id  the event must belong to the tenant the run claims to
  --                be for. The composite FK on (customer_id, event_id)
  --                would reject a mismatch too, but as a bare 23503 the
  --                worker has to decode rather than a status it can act
  --                on.
  --   status       the event must still be BEING PROCESSED. Without this,
  --                a terminal event still accepted runs: complete_
  --                automation_event deliberately leaves claim_token set
  --                on succeeded/failed/dead as a record of which claim
  --                closed it, so a worker holding that still-matching
  --                token could write history against work that had
  --                already finished. Also demonstrated live.
  --   claim_token  plain `=`, never IS NOT DISTINCT FROM — see above.
  if not exists (
    select 1
    from public.automation_events e
    where e.id = p_event_id
      and e.customer_id = p_customer_id
      and e.status = 'processing'
      and e.claim_token = p_claim_token
  ) then
    return 'not_claimed';
  end if;

  insert into public.customer_automation_runs (
    customer_id, automation_id, version_id, event_id, root_event_id,
    correlation_id, status, stop_reason, error_detail, actions_executed,
    finished_at
  ) values (
    p_customer_id, p_automation_id, p_version_id, p_event_id, p_root_event_id,
    p_correlation_id, p_status,
    nullif(btrim(coalesce(p_stop_reason, '')), ''),
    left(nullif(btrim(coalesce(p_error_detail, '')), ''), 500),
    coalesce(p_actions_executed, 0),
    now()
  )
  on conflict (automation_id, event_id) do nothing
  returning id into v_id;

  if v_id is null then
    return 'duplicate';
  end if;

  return 'ok';
end;
$$;

-- The lead facts a workflow is evaluated against. A NARROW PROJECTION,
-- not the lead row: exactly the four fields the condition registry and
-- the subject placeholders can read, and nothing else. Scoped by
-- customer_id as well as id, so a worker holding one tenant's event can
-- never resolve another tenant's lead even if an id were somehow
-- crossed.
create or replace function public.get_automation_lead_facts(
  p_token text,
  p_customer_id uuid,
  p_lead_id uuid
)
returns table (
  company text,
  contact_name text,
  source text,
  has_owner boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.verify_automation_worker(p_token) then
    return;
  end if;

  return query
  select l.company, l.contact_name, l.source, (l.owner_id is not null)
    from public.leads l
   where l.id = p_lead_id
     and l.customer_id = p_customer_id;
end;
$$;

-- ---------------------------------------------------------------------
-- The one privileged write: unattended task creation
-- ---------------------------------------------------------------------
--
-- Modelled on ingest_lead() line for line in the parts that matter:
-- token-gated, tenant resolved server-side, every referenced row
-- re-verified as belonging to that tenant and still Active, dedupe
-- BEFORE any state-advancing side effect, and a unique index as the real
-- backstop underneath.
--
-- WHAT IT DELIBERATELY DOES NOT DO: accept a customer_id, a role, or an
-- owner it has not verified itself. p_customer_id arrives from a claimed
-- event row that the database itself wrote — never from a client, never
-- from a workflow definition — and every other id is checked against it
-- before use.
create or replace function public.create_automation_task(
  p_token text,
  p_customer_id uuid,
  p_lead_id uuid,
  p_automation_id uuid,
  p_automation_key text,
  p_subject text,
  p_description text,
  p_type text,
  p_priority text,
  p_due_date date,
  p_assignment_mode text,
  p_fixed_assignee uuid,
  p_round_robin_pool uuid[]
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignee uuid;
  v_total integer;
  v_current_rn integer;
  v_subject text;
  v_inserted uuid;
  v_status text;
  v_active_version uuid;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  if p_automation_key is null or btrim(p_automation_key) = '' then
    -- Refusing to write without an idempotency key is the point: a task
    -- created without one could be created again by the next retry.
    return 'missing_idempotency_key';
  end if;

  -- 1. IDEMPOTENCY FIRST, before anything with a side effect. A retry
  --    must not advance the round-robin rotation — otherwise every
  --    redelivery burns a participant's turn, the exact bug ingest_lead()
  --    documents in its own step 2.
  if exists (
    select 1 from public.tasks
     where customer_id = p_customer_id
       and automation_key = p_automation_key
  ) then
    return 'duplicate';
  end if;

  -- 2. THE AUTOMATION MUST EXIST, BELONG TO THIS TENANT, AND BE
  --    ELIGIBLE TO RUN RIGHT NOW.
  --
  --    All four of those were missing, and all four were demonstrated
  --    against a real PostgreSQL: this function would create a task for
  --    another tenant's automation, for a Draft that had never been
  --    switched on, for one an admin had deliberately switched off, and
  --    for an automation id that did not exist at all.
  --
  --    The engine does check eligibility before it gets here, via
  --    get_active_automations. That is exactly why this check belongs
  --    here too — the engine's check is one layer, and a privileged
  --    SECURITY DEFINER function that creates real records must not
  --    depend on its caller having been careful. "Switched off" has to
  --    mean nothing runs, including through a caller with a bug.
  --
  --    Ordered AFTER the idempotency check on purpose: a retry of work
  --    that already succeeded should report 'duplicate' even if the
  --    automation has since been deactivated. The task genuinely exists;
  --    reporting it as a failure because of a later state change would
  --    make the engine retry something already done.
  select a.status, a.active_version_id
    into v_status, v_active_version
    from public.customer_automations a
   where a.id = p_automation_id
     and a.customer_id = p_customer_id;

  if not found then
    return 'invalid_automation';
  end if;

  if v_status <> 'Active' or v_active_version is null then
    return 'automation_not_active';
  end if;

  -- 3. The lead must exist AND belong to this tenant. Both halves
  --    matter: the composite FK below would catch a cross-tenant lead,
  --    but catching it here means a clear status instead of a constraint
  --    violation the worker has to decode.
  if not exists (
    select 1 from public.leads
     where id = p_lead_id
       and customer_id = p_customer_id
  ) then
    return 'invalid_lead';
  end if;

  -- 4. Assignee resolution. Only Active members of THIS customer are
  --    eligible, in either mode.
  if p_assignment_mode = 'Fixed' then
    select cu.id into v_assignee
      from public.customer_users cu
     where cu.id = p_fixed_assignee
       and cu.customer_id = p_customer_id
       and cu.status = 'Active';

  elsif p_assignment_mode = 'RoundRobin' then
    -- Rotation by POSITION within the configured pool, not "whoever
    -- sorts after the last one" — the same modular-arithmetic form
    -- ingest_lead() uses, and for the same reason: all three wrap cases
    -- (never run, mid-list, at the end) fall out of one expression.
    --
    -- The pool is ordered by the array's own subscript, so it rotates in
    -- the order the admin arranged in the builder rather than in
    -- whatever order the database happens to return.
    --
    -- FOR UPDATE on the automation row: two workers resolving the same
    -- rotation at once must not both read the same cursor.
    perform 1 from public.customer_automations
      where id = p_automation_id and customer_id = p_customer_id
      for update;

    with pool as (
      select cu.id, row_number() over (order by p.ord) as rn
        from unnest(coalesce(p_round_robin_pool, array[]::uuid[])) with ordinality as p(user_id, ord)
        join public.customer_users cu
          on cu.id = p.user_id
         and cu.customer_id = p_customer_id
         and cu.status = 'Active'
    )
    select count(*)::integer into v_total from pool;

    if v_total = 0 then
      -- Everyone on the roster was removed or deactivated. tasks.
      -- assigned_to is NOT NULL, so there is no "unassigned task" to
      -- fall back to the way ingest_lead() can leave a lead unassigned.
      return 'no_eligible_assignee';
    end if;

    with pool as (
      select cu.id, row_number() over (order by p.ord) as rn
        from unnest(coalesce(p_round_robin_pool, array[]::uuid[])) with ordinality as p(user_id, ord)
        join public.customer_users cu
          on cu.id = p.user_id
         and cu.customer_id = p_customer_id
         and cu.status = 'Active'
    )
    select pool.rn into v_current_rn
      from pool
      join public.customer_automations a
        on a.id = p_automation_id
       and a.customer_id = p_customer_id
     where pool.id = a.last_assigned_to;

    v_current_rn := (coalesce(v_current_rn, 0) % v_total) + 1;

    with pool as (
      select cu.id, row_number() over (order by p.ord) as rn
        from unnest(coalesce(p_round_robin_pool, array[]::uuid[])) with ordinality as p(user_id, ord)
        join public.customer_users cu
          on cu.id = p.user_id
         and cu.customer_id = p_customer_id
         and cu.status = 'Active'
    )
    select pool.id into v_assignee from pool where pool.rn = v_current_rn;

  else
    return 'invalid_assignment_mode';
  end if;

  if v_assignee is null then
    -- A Fixed assignee who has since been deactivated, or was never in
    -- this tenant at all.
    return 'no_eligible_assignee';
  end if;

  -- 5. Validate against the SAME constraints a human-created task faces,
  --    reported as statuses rather than left to the CHECK constraints —
  --    a worker needs to distinguish "this workflow is misconfigured"
  --    from "the database is broken", and a raw constraint violation
  --    cannot tell it which.
  v_subject := nullif(btrim(coalesce(p_subject, '')), '');
  if v_subject is null then
    return 'invalid_subject';
  end if;
  if p_type is null or p_type not in ('Call', 'Meeting', 'Email', 'Other') then
    return 'invalid_type';
  end if;
  if p_priority is null or p_priority not in ('Low', 'Medium', 'High') then
    return 'invalid_priority';
  end if;
  if p_due_date is null then
    return 'invalid_due_date';
  end if;

  -- 6. Write. created_by is NULL and that is correct: no human created
  --    this task. The column is nullable (on delete set null), so NULL
  --    already means "no user account is behind this row" rather than
  --    requiring a synthetic user to stand in for the scheduler.
  --    automation_id IS RECORDED, so "what created this task?" is a
  --    foreign key rather than a substring of the idempotency key. Its
  --    composite FK against (customer_id, id) means this insert would
  --    fail outright if p_automation_id belonged to another tenant, even
  --    if the check in step 2 were ever removed.
  insert into public.tasks (
    customer_id, lead_id, subject, description, priority, due_date,
    assigned_to, type, status, created_by, automation_key, automation_id
  ) values (
    p_customer_id,
    p_lead_id,
    v_subject,
    nullif(btrim(coalesce(p_description, '')), ''),
    p_priority,
    p_due_date,
    v_assignee,
    p_type,
    'Pending',
    null,
    p_automation_key,
    p_automation_id
  )
  on conflict do nothing
  returning id into v_inserted;

  if v_inserted is null then
    -- The unique index caught a genuine race that slipped past step 1 —
    -- two workers claiming the same event at the same instant. The
    -- rotation was advanced by whichever one won, not by both.
    return 'duplicate';
  end if;

  -- 7. Advance the rotation ONLY after a task actually landed. An
  --    automation that fails validation must not silently consume a
  --    participant's turn.
  if p_assignment_mode = 'RoundRobin' then
    update public.customer_automations
       set last_assigned_to = v_assignee
     where id = p_automation_id
       and customer_id = p_customer_id;
  end if;

  return 'created';
end;
$$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
--
-- ADMIN-only on all four tables, for SELECT as well as writes. An
-- automation defines privileged unattended behavior and its run history
-- can name records across the whole reporting hierarchy, so this follows
-- customer_integrations (admin-only even to read) rather than tasks
-- (hierarchy-visible). is_customer_admin() already requires an Active
-- membership, so a deactivated admin loses access without a separate
-- status check here.

alter table public.customer_automations enable row level security;

create policy "admins can view their customer's automations"
  on public.customer_automations for select
  to authenticated
  using (public.is_customer_admin(customer_id));

-- created_by = auth.uid() IS PART OF THE POLICY, not left to the
-- application. Without it an admin could POST through PostgREST with
-- somebody else's user id in created_by and the audit trail would record
-- a colleague as the author of an automation they had never seen —
-- demonstrated against a real PostgreSQL before this clause existed.
-- Same tenant, same role, so nothing escalates; but "who set this up?"
-- is precisely the question run history exists to answer, and an
-- answerable-but-forgeable field is worse than none.
create policy "admins can create automations for their customer"
  on public.customer_automations for insert
  to authenticated
  with check (public.is_customer_admin(customer_id) and created_by = auth.uid());

create policy "admins can update their customer's automations"
  on public.customer_automations for update
  to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

revoke all on public.customer_automations from anon, authenticated;
grant select, insert, update on public.customer_automations to authenticated;

alter table public.customer_automation_versions enable row level security;

create policy "admins can view their customer's automation versions"
  on public.customer_automation_versions for select
  to authenticated
  using (public.is_customer_admin(customer_id));

-- Same created_by clause, and it matters more here: a version row IS
-- the permanent record of who authored a given definition, and it can
-- never be corrected afterwards because the table has no UPDATE grant.
create policy "admins can create automation versions for their customer"
  on public.customer_automation_versions for insert
  to authenticated
  with check (public.is_customer_admin(customer_id) and created_by = auth.uid());

-- NO UPDATE POLICY AND NO UPDATE GRANT — this is design note 3's
-- immutability, enforced as a permission rather than trusted to
-- application code. A version, once written, cannot be altered by any
-- authenticated caller; editing an automation inserts a new version.
revoke all on public.customer_automation_versions from anon, authenticated;
grant select, insert on public.customer_automation_versions to authenticated;

alter table public.automation_events enable row level security;

create policy "admins can view their customer's automation events"
  on public.automation_events for select
  to authenticated
  using (public.is_customer_admin(customer_id));

-- No INSERT/UPDATE policy or grant for anyone: the outbox is written by
-- the leads trigger and mutated only by the token-gated worker
-- functions, all of which are SECURITY DEFINER and run as the table
-- owner. An authenticated admin can read their own tenant's queue and
-- nothing else.
revoke all on public.automation_events from anon, authenticated;
grant select on public.automation_events to authenticated;

alter table public.customer_automation_runs enable row level security;

create policy "admins can view their customer's automation runs"
  on public.customer_automation_runs for select
  to authenticated
  using (public.is_customer_admin(customer_id));

-- Read-only for the same reason: history is written by the engine, and
-- nothing should be able to edit the record of what already happened.
revoke all on public.customer_automation_runs from anon, authenticated;
grant select on public.customer_automation_runs to authenticated;

-- ---------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------
--
-- ⚠️ REVOKE FROM public FIRST, AND THAT IS THE WHOLE POINT OF THIS
-- BLOCK. PostgreSQL grants EXECUTE on every new function to PUBLIC by
-- default, and PUBLIC includes anon and authenticated. So
--
--     revoke all on function f() from anon, authenticated;
--
-- does NOT make f() uncallable — it removes grants those roles never
-- individually had, while the implicit PUBLIC grant carries on. An
-- earlier version of this migration did exactly that for
-- verify_automation_worker and believed it had locked it down; a live
-- test showed both anon and authenticated could still call it, giving
-- anyone an oracle to test candidate worker tokens against. Revoking
-- from `public` is what actually closes it.
--
-- Every function therefore starts at zero and is granted back
-- explicitly, which is also what makes the list below an accurate
-- statement of the feature's attack surface rather than a partial one.

revoke all on function public.verify_automation_worker(text) from public, anon, authenticated;
revoke all on function public.rotate_automation_worker_token(interval) from public, anon, authenticated;
revoke all on function public.enqueue_lead_created_event() from public, anon, authenticated;
revoke all on function public.set_automation_event_root() from public, anon, authenticated;
revoke all on function public.claim_automation_events(text, integer, integer, integer) from public;
revoke all on function public.get_active_automations(text, uuid, text) from public;
revoke all on function public.get_automation_lineage(text, uuid) from public;
revoke all on function public.get_automation_lead_facts(text, uuid, uuid) from public;
revoke all on function public.complete_automation_event(text, uuid, uuid, text, text, boolean) from public;
revoke all on function public.record_automation_run(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, integer) from public;
revoke all on function public.create_automation_task(text, uuid, uuid, uuid, text, text, text, text, text, date, text, uuid, uuid[]) from public;

-- The worker functions are granted to anon because the cron Route
-- Handler calls them through the deliberately session-less client in
-- lib/supabase/webhook.ts — the same client and the same grant shape
-- ingest_lead() already uses. The grant is not the boundary; the token
-- check at the top of every one of them is.
--
-- NOT GRANTED TO ANYONE, by contrast: verify_automation_worker (a token
-- oracle), rotate_automation_worker_token (mints a credential), and the
-- two trigger functions (which have no meaning outside a trigger). All
-- four are reachable only as the table owner, from a SQL console.

grant execute on function public.claim_automation_events(text, integer, integer, integer) to anon, authenticated;
grant execute on function public.get_active_automations(text, uuid, text) to anon, authenticated;
grant execute on function public.get_automation_lineage(text, uuid) to anon, authenticated;
grant execute on function public.get_automation_lead_facts(text, uuid, uuid) to anon, authenticated;
grant execute on function public.complete_automation_event(text, uuid, uuid, text, text, boolean) to anon, authenticated;
grant execute on function public.record_automation_run(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, integer) to anon, authenticated;
grant execute on function public.create_automation_task(text, uuid, uuid, uuid, text, text, text, text, text, date, text, uuid, uuid[]) to anon, authenticated;

commit;
