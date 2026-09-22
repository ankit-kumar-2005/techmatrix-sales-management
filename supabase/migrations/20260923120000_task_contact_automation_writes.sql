-- Automation Studio — Task and Contact as a second and third privileged
-- write domain, following create_automation_task/update_lead_via_automation
-- (20260921120000, 20260922120000) line for line in every part that
-- matters. Additive to every prior migration — no existing column,
-- constraint, policy, row, or grant is altered or dropped.
--
-- NOT INCLUDED IN THIS MIGRATION, ON PURPOSE:
--   * Get Record (any object) — explicitly deferred pending a separate
--     design for how one node's output (a bounded collection) becomes a
--     later node's input. Nothing here depends on it.
--   * Loop — depends on Get Record.
--   * Task- or Contact-triggered automations — this migration adds
--     WRITE actions an existing Lead-triggered workflow can call, not a
--     new trigger source. get_active_automations, the outbox trigger,
--     and every event-matching path are untouched.
--   * Any change to how a human (a real logged-in session) creates or
--     edits a Task or Contact — every existing RLS policy, trigger, and
--     grant from 20260911120000_tasks.sql and 20260913120000_contacts.sql
--     is unmodified. These functions are a SEPARATE, parallel write path
--     for the session-less automation worker, exactly the same relationship
--     create_automation_task already has to the human task-creation path.
--
-- =====================================================================
-- DESIGN NOTES
-- =====================================================================
--
-- 1. DEACTIVATION COLUMNS — WHY TWO DIFFERENT NAMES, NOT ONE.
--    Every other deactivation column in this schema is named `status`,
--    text, default 'Active', check (status in ('Active','Inactive')).
--    contacts has no status-shaped column at all, so it gets exactly
--    that: `status`. tasks ALREADY has a column named `status`, and it
--    means something else — Pending/Completed, a workflow-completion
--    flag, not a soft-delete flag — added in 20260911120000 before this
--    feature existed. Reusing it for deactivation would conflate "this
--    task is done" with "this task record should stop existing for
--    practical purposes", two genuinely different facts a real task can
--    have independently (a Completed task can still be deactivated;
--    an Inactive task should not silently become "Completed" as a side
--    effect of being hidden). tasks therefore gets a second, distinctly
--    named column: `activation_status`, same text/Active-Inactive shape,
--    same default, same semantics as every other table's `status` — just
--    a different name so it cannot collide with the completion flag.
--
--    NEITHER COLUMN CHANGES ANY EXISTING RLS POLICY. Deactivation in
--    this schema has never been an RLS-level filter (an Inactive lead is
--    still SELECT-able; customer_lead_stages' own design note says so
--    explicitly) — it is an APPLICATION-level filter (hidden from
--    pickers/lists). Adding these columns does not touch
--    tasks_*/contacts_* policies at all.
--
-- 2. IDEMPOTENCY — TWO SHAPES, MATCHING THE TWO SHAPES ALREADY
--    ESTABLISHED.
--    create_automation_contact INSERTS a new row, so it gets the same
--    natural-key treatment create_automation_task already has:
--    contacts.automation_key + a partial unique index, mirroring
--    tasks.automation_key/tasks_automation_key_unique exactly.
--    update_task_via_automation, update_contact_via_automation,
--    deactivate_task_via_automation and deactivate_contact_via_automation
--    all MUTATE an existing row — there is nothing to hang a natural key
--    off of, so all four reuse the SAME generic, action-agnostic ledger
--    (customer_id, automation_key) update_lead_via_automation already
--    introduced (automation_action_executions, 20260922120000) — no new
--    ledger table.
--
-- 3. ROTATION — ONE CURSOR PER AUTOMATION, ACROSS EVERY ACTION, STILL.
--    Every assignment-capable action in this migration reads and
--    advances the SAME customer_automations.last_assigned_to column
--    create_automation_task/update_lead_via_automation already share —
--    not a second, per-object cursor. An automation that both creates a
--    task and reassigns a contact in round-robin mode rotates through
--    one shared list, exactly like Task-create + Update-Lead already do.
--
-- 4. FIELD ALLOWLISTS — DECIDED FROM THE ACTUAL SCHEMA, NOT ASSUMED.
--    tasks writable via automation: subject, description, priority,
--    due_date, type, status (Pending/Completed — marking a task done IS
--    a real automation use case), and the assignee (via assignment mode,
--    same shape as every other action). NEVER writable: customer_id,
--    lead_id (locked by protect_task_identity_columns regardless),
--    created_by, created_at, updated_at, activation_status (that is
--    deactivate_task_via_automation's own, narrower job).
--    contacts writable via automation: name, company, title, email,
--    phone, and the owner (via assignment mode). NEVER writable:
--    customer_id, lead_id (locked by protect_contact_identity_columns),
--    created_by, created_at, updated_at, status (deactivate function's
--    own job). `tags` (text[]) is DELIBERATELY NOT included — a stated
--    v1 limitation, not a silent omission: allowlisting an array column
--    needs a real decision (replace the whole array? append? dedupe?)
--    that was not asked for and would be invented here otherwise.
--
-- 5. DEACTIVATE FUNCTIONS ARE ONE-WAY. Neither
--    deactivate_task_via_automation nor deactivate_contact_via_automation
--    can set a record back to Active — that is not what "Delete Record"
--    means. Reactivation, if ever wanted, is a separate capability this
--    migration does not build.
--
-- 6. update_task_via_automation AND update_contact_via_automation BOTH
--    REFUSE TO TOUCH AN INACTIVE RECORD — 'record_inactive', checked
--    right after tenancy (same step, one SELECT), before any allowlist
--    validation, assignee resolution, or write. This is deliberate and
--    symmetric with design note 5: deactivation is meant to be a real
--    stopping point, not a UI-only hint that an automation could still
--    write straight through. The read that proves tenancy is the same
--    read that proves activation, so this adds no extra round trip.
--    deactivate_*_via_automation is EXEMPT from this rule on purpose —
--    it is what already-Inactive stays idempotent through (see design
--    note 5's "one-way" — re-deactivating an Inactive record is a
--    successful no-op, never an error).
--
-- 7. TARGETING BY A DETERMINISTIC KEY, NOT A RAW ROW ID — REVISED FROM
--    THIS MIGRATION'S FIRST DRAFT.
--    A Lead-triggered workflow has no Task or Contact of its own to act
--    on — only ones a PRIOR Create step in the SAME workflow made. The
--    first draft of this migration took a raw p_task_id/p_contact_id,
--    which has nothing in this engine that could ever supply it. Fixed
--    by having all four of update_task_via_automation,
--    update_contact_via_automation, deactivate_task_via_automation and
--    deactivate_contact_via_automation take p_target_key text instead —
--    the SAME deterministic automation_key (built by
--    features/automations/lib/idempotency.ts's buildAutomationKey,
--    { automationId, version, eventId, nodeId }) the REFERENCED Create
--    node's own row was inserted under, just recomputed with that
--    Create node's id in place of this node's own. The row is looked up
--    by (customer_id, automation_key) — the exact unique index
--    tasks_automation_key_unique/contacts_automation_key_unique already
--    enforces, so "multiple matching records" cannot occur structurally,
--    not just by convention.
--
--    NOT FOUND MEANS 'target_not_found', A NEW, DISTINCT STATUS FROM
--    'invalid_task'/'invalid_contact' — which still exists for the
--    "this id is well-formed but nonsense" case elsewhere in this
--    migration, but here specifically means "the Create step this node
--    references never ran on this event" (a real, expected outcome when
--    the reference crosses a branch, not an error to alarm about).
--
--    WHY THIS NEEDS NO NEW ENGINE STATE. p_automation_key (this node's
--    OWN idempotency key) and p_target_key (which row to act on) are two
--    different parameters serving two different purposes, computed the
--    same way by the same existing function, entirely in the calling
--    TypeScript executor — nothing here recomputes a key from parts, and
--    nothing new is threaded through the engine's own execution loop.
--    Sequential execution (engine.ts never runs two actions
--    concurrently), version-scoped keys, and break-on-first-failure
--    (already existing engine behaviour) are what make this safe under
--    branching, retries and a failed Create step — see the review
--    response this design was confirmed against for the full reasoning.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Deactivation columns
-- ---------------------------------------------------------------------

alter table public.contacts
  add column status text not null default 'Active' check (status in ('Active', 'Inactive'));

comment on column public.contacts.status is
  'Deactivation only — never filtered by RLS, matching every other Active/Inactive column in this schema. Set only by deactivate_contact_via_automation or a future human-facing equivalent.';

alter table public.tasks
  add column activation_status text not null default 'Active' check (activation_status in ('Active', 'Inactive'));

comment on column public.tasks.activation_status is
  'Deactivation only — deliberately NOT named `status`, which already means Pending/Completed on this table (task completion, a different fact). Set only by deactivate_task_via_automation or a future human-facing equivalent.';

-- ---------------------------------------------------------------------
-- contacts gains the same automation_key/automation_id idempotency
-- columns tasks already has, for create_automation_contact's own insert
-- (design note 2).
-- ---------------------------------------------------------------------

alter table public.contacts add column automation_key text;

comment on column public.contacts.automation_key is
  'Deterministic idempotency key for a contact created by an automation; null for every human-created contact. See automation_key composition in features/automations/lib/idempotency.ts.';

create unique index contacts_automation_key_unique
  on public.contacts (customer_id, automation_key)
  where automation_key is not null;

alter table public.contacts add column automation_id uuid;

comment on column public.contacts.automation_id is
  'Which automation created this contact, if any. Composite FK below means this can never point at another tenant''s automation.';

create index contacts_automation_id_idx on public.contacts (automation_id)
  where automation_id is not null;

alter table public.contacts
  add constraint contacts_automation_same_customer_fkey
  foreign key (customer_id, automation_id)
  references public.customer_automations (customer_id, id)
  on delete set null;

-- ---------------------------------------------------------------------
-- create_automation_contact — modelled on create_automation_task
-- (20260921120000) line for line.
-- ---------------------------------------------------------------------

create or replace function public.create_automation_contact(
  p_token text,
  p_customer_id uuid,
  p_lead_id uuid,
  p_automation_id uuid,
  p_automation_key text,
  p_name text,
  p_company text,
  p_title text,
  p_email text,
  p_phone text,
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
  v_name text;
  v_inserted uuid;
  v_status text;
  v_active_version uuid;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  if p_automation_key is null or btrim(p_automation_key) = '' then
    return 'missing_idempotency_key';
  end if;

  -- 1. Idempotency first, before anything with a side effect.
  if exists (
    select 1 from public.contacts
     where customer_id = p_customer_id
       and automation_key = p_automation_key
  ) then
    return 'duplicate';
  end if;

  -- 2. The automation must exist, belong to this tenant, and be Active.
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

  -- 3. The lead must exist and belong to this tenant.
  if not exists (
    select 1 from public.leads
     where id = p_lead_id
       and customer_id = p_customer_id
  ) then
    return 'invalid_lead';
  end if;

  -- 4. Owner resolution — contacts.owner_id is NOT NULL, so (unlike a
  --    lead) there is no "leave unassigned" outcome; a contact must
  --    always resolve to someone.
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
    return 'no_eligible_assignee';
  end if;

  -- 5. Validate against the same constraint a human-created contact faces.
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    return 'invalid_name';
  end if;

  -- 6. Write.
  insert into public.contacts (
    customer_id, lead_id, owner_id, name, company, title, email, phone,
    created_by, automation_key, automation_id
  ) values (
    p_customer_id,
    p_lead_id,
    v_assignee,
    v_name,
    nullif(btrim(coalesce(p_company, '')), ''),
    nullif(btrim(coalesce(p_title, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    null,
    p_automation_key,
    p_automation_id
  )
  on conflict do nothing
  returning id into v_inserted;

  if v_inserted is null then
    return 'duplicate';
  end if;

  -- 7. Advance the rotation only after a contact actually landed.
  if p_assignment_mode = 'RoundRobin' then
    update public.customer_automations
       set last_assigned_to = v_assignee
     where id = p_automation_id
       and customer_id = p_customer_id;
  end if;

  return 'created';
end;
$$;

revoke all on function public.create_automation_contact(text, uuid, uuid, uuid, text, text, text, text, text, text, text, uuid, uuid[]) from public;
grant execute on function public.create_automation_contact(text, uuid, uuid, uuid, text, text, text, text, text, text, text, uuid, uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------------
-- update_task_via_automation — modelled on update_lead_via_automation
-- (20260922120000) line for line. No lineage parameters: tasks has no
-- outbox trigger of its own, so a write here cannot raise a new
-- automation event — there is nothing for MAX_WORKFLOW_DEPTH or the
-- ancestry check to need to see.
-- ---------------------------------------------------------------------

create or replace function public.update_task_via_automation(
  p_token text,
  p_customer_id uuid,
  -- The referenced Create Task node's own automation_key, recomputed by
  -- the calling TypeScript executor (buildAutomationKey with THAT
  -- node's id) — never a raw row id. See design note 7.
  p_target_key text,
  p_automation_id uuid,
  p_automation_key text,
  p_subject text,
  p_description text,
  p_priority text,
  p_due_date date,
  p_type text,
  p_status text,
  p_assign_owner boolean,
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
  v_status text;
  v_active_version uuid;
  v_assignee uuid;
  v_total integer;
  v_current_rn integer;
  v_updated_id uuid;
  v_task_activation text;
  v_task_id uuid;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  if p_automation_key is null or btrim(p_automation_key) = '' then
    return 'missing_idempotency_key';
  end if;

  -- 1. Idempotency first.
  insert into public.automation_action_executions (customer_id, automation_key)
  values (p_customer_id, p_automation_key)
  on conflict do nothing;

  if not found then
    return 'duplicate';
  end if;

  -- 2. The automation must exist, belong to this tenant, and be Active.
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

  -- 3. TARGETING (design note 7). p_target_key names the row, not a raw
  --    id — 'target_not_found' covers both "no Create ran under this key
  --    yet" (a branch that skipped it) and "wrong tenant", identically,
  --    since the WHERE clause filters both in one read. Then, same as
  --    before: the task must be Active. An Inactive task is what
  --    "Delete Record" produced — nothing an automation does may modify
  --    a record once it has been deactivated.
  select id, activation_status into v_task_id, v_task_activation
    from public.tasks
   where automation_key = p_target_key and customer_id = p_customer_id;

  if not found then
    return 'target_not_found';
  end if;
  if v_task_activation <> 'Active' then
    return 'record_inactive';
  end if;

  -- 4. Validate the allowlisted values that were actually supplied. NULL
  --    means "leave this field alone" throughout — only a non-null value
  --    is validated or written.
  if p_subject is not null and nullif(btrim(p_subject), '') is null then
    return 'invalid_subject';
  end if;
  if p_priority is not null and p_priority not in ('Low', 'Medium', 'High') then
    return 'invalid_priority';
  end if;
  if p_type is not null and p_type not in ('Call', 'Meeting', 'Email', 'Other') then
    return 'invalid_type';
  end if;
  if p_status is not null and p_status not in ('Pending', 'Completed') then
    return 'invalid_status';
  end if;

  -- 5. Owner resolution — same shape as every other action.
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
  --    CAN TOUCH — customer_id/lead_id/created_by/activation_status have
  --    no parameter that could reach them.
  update public.tasks
     set subject = coalesce(nullif(btrim(p_subject), ''), subject),
         description = case when p_description is not null then nullif(btrim(p_description), '') else description end,
         priority = coalesce(p_priority, priority),
         due_date = coalesce(p_due_date, due_date),
         type = coalesce(p_type, type),
         status = coalesce(p_status, status),
         assigned_to = case when p_assign_owner then v_assignee else assigned_to end
   where id = v_task_id
     and customer_id = p_customer_id
  returning id into v_updated_id;

  if v_updated_id is null then
    -- Unreachable in practice — v_task_id was just confirmed to exist in
    -- the same transaction, and nothing in this app deletes a task —
    -- but a write that finds nothing must never silently report success.
    return 'target_not_found';
  end if;

  -- 7. Advance the rotation only after a write actually landed.
  if p_assign_owner and p_assignment_mode = 'RoundRobin' then
    update public.customer_automations
       set last_assigned_to = v_assignee
     where id = p_automation_id
       and customer_id = p_customer_id;
  end if;

  return 'updated';
end;
$$;

revoke all on function public.update_task_via_automation(text, uuid, text, uuid, text, text, text, text, date, text, text, boolean, text, uuid, uuid[]) from public;
grant execute on function public.update_task_via_automation(text, uuid, text, uuid, text, text, text, text, date, text, text, boolean, text, uuid, uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------------
-- update_contact_via_automation — same shape, for contacts. Also no
-- lineage parameters, for the same reason (no outbox trigger on
-- contacts).
-- ---------------------------------------------------------------------

create or replace function public.update_contact_via_automation(
  p_token text,
  p_customer_id uuid,
  -- The referenced Create Contact node's own automation_key — see
  -- update_task_via_automation's identical parameter and design note 7.
  p_target_key text,
  p_automation_id uuid,
  p_automation_key text,
  p_name text,
  p_company text,
  p_title text,
  p_email text,
  p_phone text,
  p_assign_owner boolean,
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
  v_status text;
  v_active_version uuid;
  v_assignee uuid;
  v_total integer;
  v_current_rn integer;
  v_updated_id uuid;
  v_contact_activation text;
  v_contact_id uuid;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  if p_automation_key is null or btrim(p_automation_key) = '' then
    return 'missing_idempotency_key';
  end if;

  insert into public.automation_action_executions (customer_id, automation_key)
  values (p_customer_id, p_automation_key)
  on conflict do nothing;

  if not found then
    return 'duplicate';
  end if;

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

  -- TARGETING (design note 7) — see update_task_via_automation's
  -- identical step for the full reasoning.
  select id, status into v_contact_id, v_contact_activation
    from public.contacts
   where automation_key = p_target_key and customer_id = p_customer_id;

  if not found then
    return 'target_not_found';
  end if;
  if v_contact_activation <> 'Active' then
    return 'record_inactive';
  end if;

  if p_name is not null and nullif(btrim(p_name), '') is null then
    return 'invalid_name';
  end if;

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

  update public.contacts
     set name = coalesce(nullif(btrim(p_name), ''), name),
         company = case when p_company is not null then nullif(btrim(p_company), '') else company end,
         title = case when p_title is not null then nullif(btrim(p_title), '') else title end,
         email = case when p_email is not null then nullif(btrim(p_email), '') else email end,
         phone = case when p_phone is not null then nullif(btrim(p_phone), '') else phone end,
         owner_id = case when p_assign_owner then v_assignee else owner_id end
   where id = v_contact_id
     and customer_id = p_customer_id
  returning id into v_updated_id;

  if v_updated_id is null then
    return 'target_not_found';
  end if;

  if p_assign_owner and p_assignment_mode = 'RoundRobin' then
    update public.customer_automations
       set last_assigned_to = v_assignee
     where id = p_automation_id
       and customer_id = p_customer_id;
  end if;

  return 'updated';
end;
$$;

revoke all on function public.update_contact_via_automation(text, uuid, text, uuid, text, text, text, text, text, text, boolean, text, uuid, uuid[]) from public;
grant execute on function public.update_contact_via_automation(text, uuid, text, uuid, text, text, text, text, text, text, boolean, text, uuid, uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------------
-- deactivate_task_via_automation / deactivate_contact_via_automation —
-- "Delete Record", mapped to the same deactivation convention every
-- other table in this schema uses. One-way (design note 5): can only
-- move Active -> Inactive, never back.
-- ---------------------------------------------------------------------

create or replace function public.deactivate_task_via_automation(
  p_token text,
  p_customer_id uuid,
  -- The referenced Create Task node's own automation_key — see
  -- update_task_via_automation's identical parameter and design note 7.
  p_target_key text,
  p_automation_id uuid,
  p_automation_key text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_active_version uuid;
  v_updated_id uuid;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  if p_automation_key is null or btrim(p_automation_key) = '' then
    return 'missing_idempotency_key';
  end if;

  insert into public.automation_action_executions (customer_id, automation_key)
  values (p_customer_id, p_automation_key)
  on conflict do nothing;

  if not found then
    return 'duplicate';
  end if;

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

  -- TARGETING (design note 7), and never a literal DELETE. Only ever
  -- Active -> Inactive; already-Inactive is treated as a no-op success,
  -- not an error, so a retry of a call that already landed reports the
  -- same outcome — which is also why this looks the row up and writes
  -- it in one statement rather than reading activation_status first the
  -- way the update functions do: there is no "reject if already
  -- Inactive" branch here to need that read for.
  update public.tasks
     set activation_status = 'Inactive'
   where automation_key = p_target_key
     and customer_id = p_customer_id
  returning id into v_updated_id;

  if v_updated_id is null then
    return 'target_not_found';
  end if;

  return 'deactivated';
end;
$$;

revoke all on function public.deactivate_task_via_automation(text, uuid, text, uuid, text) from public;
grant execute on function public.deactivate_task_via_automation(text, uuid, text, uuid, text) to anon, authenticated;

create or replace function public.deactivate_contact_via_automation(
  p_token text,
  p_customer_id uuid,
  -- The referenced Create Contact node's own automation_key — see
  -- update_task_via_automation's identical parameter and design note 7.
  p_target_key text,
  p_automation_id uuid,
  p_automation_key text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_active_version uuid;
  v_updated_id uuid;
begin
  if not public.verify_automation_worker(p_token) then
    return 'unauthorized';
  end if;

  if p_automation_key is null or btrim(p_automation_key) = '' then
    return 'missing_idempotency_key';
  end if;

  insert into public.automation_action_executions (customer_id, automation_key)
  values (p_customer_id, p_automation_key)
  on conflict do nothing;

  if not found then
    return 'duplicate';
  end if;

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

  -- TARGETING (design note 7); one-way, never a literal DELETE — see
  -- deactivate_task_via_automation's identical note.
  update public.contacts
     set status = 'Inactive'
   where automation_key = p_target_key
     and customer_id = p_customer_id
  returning id into v_updated_id;

  if v_updated_id is null then
    return 'target_not_found';
  end if;

  return 'deactivated';
end;
$$;

revoke all on function public.deactivate_contact_via_automation(text, uuid, text, uuid, text) from public;
grant execute on function public.deactivate_contact_via_automation(text, uuid, text, uuid, text) to anon, authenticated;

commit;
