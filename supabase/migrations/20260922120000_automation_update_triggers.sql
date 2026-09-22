
-- Automation Studio — record-triggered events (Created / Updated /
-- Created-or-Updated), a dynamic old/new snapshot, and the second
-- privileged write (Update Lead). Additive to 20260921120000_automations.sql
-- — no existing column, constraint, policy, row or grant from that
-- migration is altered or dropped, except where explicitly noted below.
--
-- =====================================================================
-- DESIGN NOTES
-- =====================================================================
--
-- 1. THE TRIGGER FUNCTION IS RENAMED, NOT JUST GENERALIZED.
--    enqueue_lead_created_event only ever fired on INSERT; its name said
--    so. It now fires on INSERT OR UPDATE, so it is renamed to
--    enqueue_lead_automation_event — this codebase's names describe what
--    a function does, and "created" would now be a lie for half of what
--    it does. The old trigger and function are dropped (trigger first,
--    then function — a function cannot be dropped while a trigger still
--    references it) and replaced, not altered in place, because
--    CREATE OR REPLACE cannot rename a function.
--
-- 2. THE EVENT PAYLOAD NOW SNAPSHOTS THE WHOLE ROW, OLD AND NEW —
--    DELIBERATELY, NOT AS AN OVERSIGHT-AVOIDING SHORTCUT.
--    The previous payload was a hand-picked 3 fields (source, owner_id,
--    stage_id), because those were the only fields any condition could
--    read. Conditions can now read any allowlisted Lead field (see
--    features/automations/registry/fields.ts), and the alternative —
--    widening the trigger's field list every time the condition registry
--    grows — would mean a migration every time a new field becomes
--    filterable. Snapshotting to_jsonb(NEW)/to_jsonb(OLD) once, now,
--    means every field the registry will ever expose is already being
--    captured; the registry can grow in TypeScript alone from here on.
--
--    customer_id and id are stripped from the snapshot — customer_id is
--    redundant with automation_events.customer_id itself (and stripping
--    it means the snapshot can never be mistaken for a second, competing
--    tenant boundary), id is redundant with automation_events.subject_id.
--
--    changed_fields is computed GENERICALLY by diffing the two JSONB
--    maps key-by-key, not from a hardcoded column list — the same reason
--    as the snapshot itself: it stays correct as leads gains columns,
--    with no trigger change required.
--
-- 3. trigger_event_type IS DENORMALIZED ONTO THE VERSION ROW, FOLLOWING
--    THE EXACT PRECEDENT 20260921120000 ALREADY SET FOR trigger_type:
--    that migration's own design notes justify pulling trigger_type out
--    of `definition` into a real column specifically so the engine can
--    match an incoming event in SQL rather than parsing JSON for every
--    candidate. eventType (created/updated/created_or_updated) is the
--    same kind of fact — read by SQL on every claim — so it gets the
--    same treatment, not a JSONB path lookup.
--
--    THE ENQUEUE GUARD IS TIGHTENED FOR THE SAME REASON, NOT AS AN
--    AFTERTHOUGHT: without checking trigger_event_type, EVERY lead edit
--    in the entire app — for any tenant with even one Active,
--    Created-only automation — would write an outbox row that the engine
--    would correctly, but wastefully, evaluate as "skipped" on every
--    single edit forever. The guard now joins to the active version and
--    only writes a row when some Active automation's own trigger_event_type
--    actually matches this operation.
--
-- 4. WHY A SEPARATE IDEMPOTENCY LEDGER (automation_action_executions),
--    RATHER THAN REUSING tasks.automation_key.
--    create_automation_task's idempotency works because it has somewhere
--    natural to put the key: the task row it is about to insert. Update
--    Lead has no such row — it mutates an existing one, so there is
--    nothing to hang a partial unique index off of. A generic,
--    action-agnostic ledger (customer_id, automation_key) solves this
--    for Update Lead now and for any future non-inserting action later,
--    the same way tasks_automation_key_unique solves it for actions that
--    do insert. Checked FIRST, before any round-robin resolution — same
--    reasoning as create_automation_task's own step 1: a retry must not
--    advance a rotation for work that already happened.
--
-- 5. update_lead_via_automation FOLLOWS create_automation_task LINE FOR
--    LINE in the parts that matter: token-gated, idempotency before any
--    side effect, automation existence+tenancy+eligibility re-verified
--    (not trusted from the caller), lead tenancy re-verified, an
--    EXPLICIT ALLOWLIST of writable columns (next_step, deal_value,
--    status, owner_id — company/contact_name/email/phone/source/
--    stage_id/closed_at/customer_id are none of them accepted as
--    parameters, so there is no argument that could smuggle a write to
--    them even by a future caller's mistake), and the rotation advances
--    only after a write actually lands.
--
--    stage_id IS DELIBERATELY NOT WRITABLE HERE. leads_protect_
--    stage_transition (20260907120000) enforces which stage transitions
--    are legal on every UPDATE, automation-originated or not — so
--    routing a stage change through this function would not bypass that
--    trigger, but making an automation's stage change respect the SAME
--    transition rules a human would need to follow, with an honest error
--    surfaced as run history rather than a raw constraint violation, is
--    real additional work deferred to a later phase rather than done
--    partially here.
--
--    "" (empty string) vs SQL NULL for p_next_step is a real, documented
--    distinction: NULL means "leave this field alone", "" means "set it
--    to empty". There is no way in this version to distinguish "the
--    admin left this blank in the builder" from "leave alone" — the
--    builder always sends NULL for an unconfigured field, never "". A
--    "clear this field" UX is a stated v1 limitation, not silently
--    missing.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Idempotency ledger for actions with nothing to key against (design note 4)
-- ---------------------------------------------------------------------

create table public.automation_action_executions (
  customer_id uuid not null references public.customers (id) on delete cascade,
  automation_key text not null,
  created_at timestamptz not null default now(),
  constraint automation_action_executions_pkey primary key (customer_id, automation_key)
);

-- RLS on, zero policies — same stance as automation_worker_config and
-- automation_events: this is engine bookkeeping, not tenant-readable
-- data, and the only code that ever needs it is a SECURITY DEFINER
-- function running as the table owner.
alter table public.automation_action_executions enable row level security;
revoke all on public.automation_action_executions from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- The event payload gains real columns for operation + snapshots
-- ---------------------------------------------------------------------

alter table public.automation_events
  add column operation text not null default 'created'
    check (operation in ('created', 'updated')),
  add column old_values jsonb,
  add column new_values jsonb,
  add column changed_fields text[];

comment on column public.automation_events.operation is
  'Which lifecycle event produced this row. Every historical row before this migration was implicitly a creation, hence the backfilled default.';
comment on column public.automation_events.old_values is
  'to_jsonb(OLD) minus customer_id/id at the moment of the event. NULL for a created event — there is no prior state.';
comment on column public.automation_events.new_values is
  'to_jsonb(NEW) minus customer_id/id at the moment of the event. This is a SNAPSHOT: condition evaluation must read this, not the live row, which may have changed again by the time a worker processes the event.';
comment on column public.automation_events.changed_fields is
  'Keys where old_values and new_values differ, computed generically (no hardcoded column list). NULL for a created event.';

-- ---------------------------------------------------------------------
-- Which lifecycle a workflow version is configured for (design note 3)
-- ---------------------------------------------------------------------

alter table public.customer_automation_versions
  add column trigger_event_type text not null default 'created'
    check (trigger_event_type in ('created', 'updated', 'created_or_updated'));

comment on column public.customer_automation_versions.trigger_event_type is
  'Denormalized from the trigger node''s own config.eventType, the same way trigger_type is denormalized from definition — read in SQL by get_active_automations and the enqueue guard so neither has to parse JSONB on every claim.';

-- ---------------------------------------------------------------------
-- The generalized trigger function (design notes 1, 2, 3)
-- ---------------------------------------------------------------------

create or replace function public.enqueue_lead_automation_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation text;
  v_old_values jsonb;
  v_new_values jsonb;
  v_changed_fields text[];
  v_lineage_root uuid;
  v_lineage_correlation uuid;
  v_lineage_depth integer;
begin
  if tg_op = 'INSERT' then
    v_operation := 'created';
    v_old_values := null;
    v_new_values := to_jsonb(new) - 'customer_id' - 'id';
    v_changed_fields := null;
  else
    v_operation := 'updated';
    v_old_values := to_jsonb(old) - 'customer_id' - 'id';
    v_new_values := to_jsonb(new) - 'customer_id' - 'id';

    -- GENERIC diff — no hardcoded column list (design note 2). A key
    -- present in both maps with a different value is "changed"; every
    -- column of `leads` is present in both maps by construction, so this
    -- is a complete diff, not a partial one.
    select array_agg(n.key) into v_changed_fields
      from jsonb_each(v_new_values) n
      join jsonb_each(v_old_values) o using (key)
     where n.value is distinct from o.value;
  end if;

  -- THE GUARD (design note 3): do nothing at all unless some Active
  -- automation's own trigger_event_type actually matches this operation.
  -- Blast-radius control, tightened from the insert-only version: a
  -- tenant running only Created-only automations gets no extra write on
  -- an UPDATE, exactly as they got no extra write on an INSERT before
  -- they had any automation at all.
  if exists (
    select 1
    from public.customer_automations a
    join public.customer_automation_versions v
      on v.id = a.active_version_id
     and v.customer_id = a.customer_id
    where a.customer_id = new.customer_id
      and a.status = 'Active'
      and (v.trigger_event_type = v_operation or v.trigger_event_type = 'created_or_updated')
  ) then
    -- ⚠️ LINEAGE PROPAGATION — THE FIX FOR A LOOP THE SAFEGUARDS COULD
    -- NOT SEE. Found by testing the real execution path, not assumed
    -- safe: before this, an event produced by update_lead_via_automation
    -- writing to `leads` looked, to this trigger, IDENTICAL to an
    -- ordinary human edit — a fresh root at depth 0. Every safeguard in
    -- 20260921120000 (MAX_WORKFLOW_DEPTH, the ancestry check) keys off
    -- root_event_id and depth, so an Update Lead action that caused its
    -- own condition to keep matching could re-trigger itself FOREVER,
    -- each generation recorded as an unrelated depth-0 root — nothing
    -- in the existing machinery would ever refuse it.
    --
    -- update_lead_via_automation now sets three TRANSACTION-LOCAL
    -- settings immediately before the UPDATE that reaches this trigger
    -- (app.automation_root_event_id/correlation_id/depth), carrying
    -- forward the lineage of the event that CAUSED this write. When
    -- present, this event inherits that lineage instead of starting a
    -- new one — which is what makes MAX_WORKFLOW_DEPTH and the ancestry
    -- check finally able to see a chain an automation's own writes
    -- created, and stop it.
    --
    -- ABSENT for every other caller — a plain human UPDATE (RLS client,
    -- no automation involved) never sets these, and correctly still
    -- gets a fresh root at depth 0, exactly as before this fix. Nothing
    -- about ordinary, non-automated lead editing changes.
    v_lineage_root := nullif(current_setting('app.automation_root_event_id', true), '')::uuid;
    v_lineage_correlation := nullif(current_setting('app.automation_correlation_id', true), '')::uuid;
    v_lineage_depth := nullif(current_setting('app.automation_depth', true), '')::integer;

    insert into public.automation_events (
      customer_id, event_type, subject_id, operation, old_values, new_values, changed_fields, payload,
      root_event_id, correlation_id, depth
    ) values (
      new.customer_id,
      'lead.created',
      new.id,
      v_operation,
      v_old_values,
      v_new_values,
      v_changed_fields,
      -- payload is superseded by new_values but left populated (not
      -- dropped) — see the migration's own note in 20260921120000 on
      -- why an unused-but-present column is preferred to a destructive
      -- one; nothing reads this going forward.
      jsonb_build_object('source', new.source, 'owner_id', new.owner_id, 'stage_id', new.stage_id),
      -- root_event_id: NULL when there is no lineage to inherit, which
      -- automation_events_set_root (the BEFORE INSERT trigger) then
      -- fills to this row's own id — the existing "a root event is its
      -- own root" behavior, untouched for the ordinary case.
      v_lineage_root,
      coalesce(v_lineage_correlation, gen_random_uuid()),
      coalesce(v_lineage_depth, 0)
    );
  end if;

  return new;
end;
$$;

drop trigger leads_enqueue_automation_event on public.leads;
drop function public.enqueue_lead_created_event();

create trigger leads_enqueue_automation_event
  after insert or update on public.leads
  for each row execute function public.enqueue_lead_automation_event();

revoke all on function public.enqueue_lead_automation_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- get_active_automations gains operation matching
-- ---------------------------------------------------------------------
--
-- Dropped and recreated (not CREATE OR REPLACE) because it gains a
-- parameter — Postgres allows CREATE OR REPLACE to add trailing
-- parameters only when they carry defaults, and this one is required,
-- so a clean drop+recreate is more honest than relying on that edge
-- case. It has exactly one caller (the engine), so the signature change
-- is contained.

drop function public.get_active_automations(text, uuid, text);

create or replace function public.get_active_automations(
  p_token text,
  p_customer_id uuid,
  p_trigger_type text,
  p_operation text
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
     and (v.trigger_event_type = p_operation or v.trigger_event_type = 'created_or_updated')
   order by a.created_at, a.id;
end;
$$;

revoke all on function public.get_active_automations(text, uuid, text, text) from public;
grant execute on function public.get_active_automations(text, uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Teaching protect_lead_owner_id_change() about the automation path
-- ---------------------------------------------------------------------
--
-- A REAL CONFLICT, FOUND BY TESTING update_lead_via_automation'S OWN
-- ROUND-ROBIN PATH AGAINST A REAL POSTGRESQL, NOT ANTICIPATED IN
-- DESIGN: 20260906120000_lead_hierarchy_and_optional_fields.sql's
-- protect_lead_owner_id_change() rejects any owner_id change unless
-- is_customer_admin(old.customer_id) is true — and that check reads
-- auth.uid(), which is NULL for the engine's every call, since it has
-- no session. Left as-is, Update Lead's owner-reassignment would fail
-- on every single call with "Only an admin may change a lead's owner.",
-- making half of that action permanently non-functional.
--
-- THE FIX IS NARROW AND DOES NOT WEAKEN THE TRIGGER FOR ANYONE ELSE. A
-- session-scoped setting (`app.automation_owner_change`), set to
-- 'authorized' by update_lead_via_automation ONLY, immediately before
-- the one UPDATE that needs it, using set_config(..., true) — the
-- `true` makes it TRANSACTION-LOCAL, so it is reset at commit or
-- rollback and can never leak into a later call sharing a pooled
-- connection. The trigger accepts EITHER the existing admin check OR
-- this flag — it does not accept "no session at all", which would have
-- quietly authorized any other no-session code path this app ever
-- grows, not just this one.
--
-- Reaching this flag at all still requires everything
-- update_lead_via_automation already requires: a valid worker token (an
-- environment secret never sent to the browser), and an Active
-- automation — which can only exist because an ADMIN built and
-- activated it (customer_automations' own INSERT/UPDATE RLS). The
-- authorization is real, it is simply established at workflow-activation
-- time rather than at request time, which is the only kind of
-- "admin says so" an unattended engine can ever produce.
create or replace function public.protect_lead_owner_id_change()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    if not public.is_customer_admin(old.customer_id)
       and current_setting('app.automation_owner_change', true) is distinct from 'authorized' then
      raise exception 'Only an admin may change a lead''s owner.';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- The second privileged write: Update Lead (design note 5)
-- ---------------------------------------------------------------------

create or replace function public.update_lead_via_automation(
  p_token text,
  p_customer_id uuid,
  p_lead_id uuid,
  p_automation_id uuid,
  p_automation_key text,
  p_next_step text,
  p_deal_value numeric,
  p_status text,
  p_assign_owner boolean,
  p_assignment_mode text,
  p_fixed_assignee uuid,
  p_round_robin_pool uuid[],
  -- THE LINEAGE OF THE EVENT CURRENTLY BEING PROCESSED — the engine
  -- always has these three (they are columns on the claimed event row)
  -- and passes them straight through. See enqueue_lead_automation_event's
  -- own note on why this is what makes the depth and ancestry
  -- safeguards able to see a loop this function's own write could
  -- otherwise start.
  p_root_event_id uuid,
  p_correlation_id uuid,
  p_depth integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_active_version uuid;
  v_assignee uuid;
  v_total integer;
  v_current_rn integer;
  v_updated_id uuid;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  if p_automation_key is null or btrim(p_automation_key) = '' then
    return 'missing_idempotency_key';
  end if;

  -- 1. IDEMPOTENCY FIRST (design note 4) — before anything with a side
  --    effect, exactly as create_automation_task's own step 1 argues.
  insert into public.automation_action_executions (customer_id, automation_key)
  values (p_customer_id, p_automation_key)
  on conflict do nothing;

  if not found then
    return 'duplicate';
  end if;

  -- 2. The automation must exist, belong to this tenant, and be
  --    eligible to run right now — the same check create_automation_task
  --    makes, for the same reason: a privileged function must not trust
  --    its caller to have been careful.
  select a.status into v_status
    from public.customer_automations a
   where a.id = p_automation_id
     and a.customer_id = p_customer_id;

  if not found then
    return 'invalid_automation';
  end if;

  select a.active_version_id into v_active_version
    from public.customer_automations a
   where a.id = p_automation_id;

  if v_status <> 'Active' or v_active_version is null then
    return 'automation_not_active';
  end if;

  -- 3. The lead must exist and belong to this tenant.
  if not exists (select 1 from public.leads where id = p_lead_id and customer_id = p_customer_id) then
    return 'invalid_lead';
  end if;

  -- 4. Validate the allowlisted values that were actually supplied.
  --    NULL means "leave this field alone" throughout (design note 5) —
  --    only a non-null value is validated or written.
  if p_deal_value is not null and p_deal_value < 0 then
    return 'invalid_deal_value';
  end if;
  if p_status is not null and p_status not in ('Active', 'Inactive') then
    return 'invalid_status';
  end if;

  -- 5. Owner resolution — only when requested, and only ever from THIS
  --    tenant's Active members. Identical modular-arithmetic rotation to
  --    create_automation_task, sharing the same last_assigned_to cursor
  --    (one rotation per automation, whichever action advances it).
  if p_assign_owner then
    if p_assignment_mode = 'Fixed' then
      select cu.id into v_assignee
        from public.customer_users cu
       where cu.id = p_fixed_assignee
         and cu.customer_id = p_customer_id
         and cu.status = 'Active';

    elsif p_assignment_mode = 'RoundRobin' then
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
        join public.customer_automations a on a.id = p_automation_id and a.customer_id = p_customer_id
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
      return 'no_eligible_assignee';
    end if;
  end if;

  -- 6. Write. THE ALLOWLIST IS THE ENTIRE SET OF COLUMNS THIS STATEMENT
  --    CAN TOUCH — company/contact_name/email/phone/source/stage_id/
  --    closed_at/customer_id have no parameter that could reach them.
  --
  --    Set ONLY when an owner change is actually about to happen, and
  --    ONLY for this one statement (set_config's third argument, `true`,
  --    makes it transaction-local — see protect_lead_owner_id_change's
  --    own note above on why this is safe under a pooled connection).
  if p_assign_owner then
    perform set_config('app.automation_owner_change', 'authorized', true);
  end if;

  -- LINEAGE, FOR EVERY WRITE THIS FUNCTION MAKES — not conditional the
  -- way the owner-change flag is, because ANY field change here can
  -- re-fire enqueue_lead_automation_event, not just an owner change.
  -- depth is incremented by exactly one: this write is one generation
  -- further from the root than the event currently being processed.
  -- Transaction-local (set_config's third argument, `true`), so it
  -- cannot leak into any statement outside this one function call.
  perform set_config('app.automation_root_event_id', p_root_event_id::text, true);
  perform set_config('app.automation_correlation_id', p_correlation_id::text, true);
  perform set_config('app.automation_depth', (coalesce(p_depth, 0) + 1)::text, true);

  update public.leads
     set next_step = case when p_next_step is not null then nullif(btrim(p_next_step), '') else next_step end,
         deal_value = coalesce(p_deal_value, deal_value),
         status = coalesce(p_status, status),
         owner_id = case when p_assign_owner then v_assignee else owner_id end
   where id = p_lead_id
     and customer_id = p_customer_id
  returning id into v_updated_id;

  if v_updated_id is null then
    -- The lead existed at step 3 but the UPDATE matched nothing — only
    -- reachable if it was deleted between the check and the write,
    -- which this app has no path for today, but the function must not
    -- silently report success for a write that did not happen.
    return 'invalid_lead';
  end if;

  -- 7. Advance the rotation only after a write actually landed —
  --    same ordering as create_automation_task's own step 7.
  if p_assign_owner and p_assignment_mode = 'RoundRobin' then
    update public.customer_automations
       set last_assigned_to = v_assignee
     where id = p_automation_id
       and customer_id = p_customer_id;
  end if;

  return 'updated';
end;
$$;

revoke all on function public.update_lead_via_automation(text, uuid, uuid, uuid, text, text, numeric, text, boolean, text, uuid, uuid[], uuid, uuid, integer) from public;
grant execute on function public.update_lead_via_automation(text, uuid, uuid, uuid, text, text, numeric, text, boolean, text, uuid, uuid[], uuid, uuid, integer) to anon, authenticated;

commit;
