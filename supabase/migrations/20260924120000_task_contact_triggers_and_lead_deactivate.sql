-- Automation Studio — Task/Contact triggers, Lead Deactivate, and the
-- lineage fix six existing functions needed the moment those triggers
-- existed. Additive to every prior automations migration — no existing
-- column, constraint, policy, row or grant is altered or dropped, except
-- the six functions explicitly re-created below (a signature change,
-- not a behavior removal — every existing status string and error path
-- is preserved character for character).
--
-- =====================================================================
-- DESIGN NOTES
-- =====================================================================
--
-- 1. TASK/CONTACT OUTBOX TRIGGERS NEED NO NEW SCHEMA.
--    automation_events.subject_id is deliberately not a foreign key and
--    event_type is deliberately plain text (see its own comment in
--    20260921120000) specifically so this table could hold events from
--    more than one source table without a migration. claim_automation_
--    events, get_active_automations and the lineage/root-event machinery
--    are ALL already fully generic — none of them changes in this
--    migration. The only genuinely new SQL is two trigger functions,
--    mirroring enqueue_lead_automation_event exactly, and their triggers.
--
-- 2. WHY THE OTHER SIX FUNCTIONS ALSO CHANGE, NOT JUST TWO NEW TRIGGERS.
--    create_automation_task, create_automation_contact, update_task_via_
--    automation, update_contact_via_automation, deactivate_task_via_
--    automation and deactivate_contact_via_automation all write to
--    tasks/contacts. Before this migration that was a dead end — neither
--    table had a trigger, so nothing downstream could ever see that
--    write. The moment enqueue_task_automation_event/enqueue_contact_
--    automation_event exist, every one of those six writes can raise a
--    NEW automation event — and, exactly like update_lead_via_automation
--    before its own fix (20260922120000, finding #15), that new event
--    would look identical to an ordinary human edit: a fresh root at
--    depth 0, invisible to MAX_WORKFLOW_DEPTH and the ancestry check.
--    An Update Task action whose own write keeps a Task-triggered
--    workflow's condition true could re-fire itself forever, the exact
--    bug class already found and fixed once for Lead — found THIS time
--    by reasoning through the consequence of adding these triggers
--    before writing them, not by waiting to reproduce it. All six gain
--    the same three trailing parameters update_lead_via_automation
--    already has (p_root_event_id, p_correlation_id, p_depth) and set
--    the same three transaction-local settings immediately before their
--    one write. Every existing status string, error path and column
--    allowlist is unchanged — this is purely the lineage fix, applied
--    before the gap it closes could ever be exploited, not after.
--
--    DROP FUNCTION, not CREATE OR REPLACE, for all six: Postgres allows
--    CREATE OR REPLACE to add trailing parameters only when they carry
--    defaults, and these are required — same reasoning 20260922120000
--    already gives for get_active_automations. Only registry/
--    executors.ts calls any of these six today (nothing has been
--    deployed outside the local test harness), so the signature change
--    has exactly one caller to update, alongside this migration.
--
-- 3. Deactivate Lead is the one-way Active -> Inactive action Task and
--    Contact already have, for Lead. leads.status already exists and is
--    already writable (as one of update_lead_via_automation's own
--    allowlisted fields) — so, unlike Task/Contact, THIS ACTION NEEDS NO
--    NEW COLUMN. It is still given its own dedicated function rather
--    than folded into "just set Update Lead's Status field to Inactive",
--    matching the discoverable, explicit convention Task/Contact's own
--    Deactivate actions already established, rather than leaving
--    deactivation as one buried option among several on a generic
--    Update action.
--
--    Deactivate Lead targets p_lead_id DIRECTLY, never through a
--    node-reference/automation_key lookup — unlike Task/Contact's
--    Update/Deactivate actions, which have no raw id of their own and
--    must name an earlier Create node in the same workflow.
--    update_lead_via_automation already established the reason this is
--    different for Lead: the lead that triggered this automation
--    already IS a concrete row (event.subject_id), never something an
--    earlier step in the SAME run created. Deactivate Lead reuses that
--    exact targeting model.
--
--    Lineage-aware from the moment it is created, the same as every
--    function this migration touches — deactivating a lead is itself a
--    write to `leads`, which re-fires leads_enqueue_automation_event.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Task outbox trigger (design note 1)
-- ---------------------------------------------------------------------

create or replace function public.enqueue_task_automation_event()
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

    select array_agg(n.key) into v_changed_fields
      from jsonb_each(v_new_values) n
      join jsonb_each(v_old_values) o using (key)
     where n.value is distinct from o.value;
  end if;

  if exists (
    select 1
    from public.customer_automations a
    join public.customer_automation_versions v
      on v.id = a.active_version_id
     and v.customer_id = a.customer_id
    where a.customer_id = new.customer_id
      and a.status = 'Active'
      and v.trigger_type = 'task.created'
      and (v.trigger_event_type = v_operation or v.trigger_event_type = 'created_or_updated')
  ) then
    -- LINEAGE PROPAGATION (design note 2) — read the same way
    -- enqueue_lead_automation_event already does. Absent for a plain
    -- human edit (a real Task Server Action, no automation involved),
    -- which correctly still gets a fresh root at depth 0.
    v_lineage_root := nullif(current_setting('app.automation_root_event_id', true), '')::uuid;
    v_lineage_correlation := nullif(current_setting('app.automation_correlation_id', true), '')::uuid;
    v_lineage_depth := nullif(current_setting('app.automation_depth', true), '')::integer;

    insert into public.automation_events (
      customer_id, event_type, subject_id, operation, old_values, new_values, changed_fields, payload,
      root_event_id, correlation_id, depth
    ) values (
      new.customer_id,
      'task.created',
      new.id,
      v_operation,
      v_old_values,
      v_new_values,
      v_changed_fields,
      jsonb_build_object('lead_id', new.lead_id, 'assigned_to', new.assigned_to),
      v_lineage_root,
      coalesce(v_lineage_correlation, gen_random_uuid()),
      coalesce(v_lineage_depth, 0)
    );
  end if;

  return new;
end;
$$;

create trigger tasks_enqueue_automation_event
  after insert or update on public.tasks
  for each row execute function public.enqueue_task_automation_event();

revoke all on function public.enqueue_task_automation_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Contact outbox trigger (design note 1)
-- ---------------------------------------------------------------------

create or replace function public.enqueue_contact_automation_event()
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

    select array_agg(n.key) into v_changed_fields
      from jsonb_each(v_new_values) n
      join jsonb_each(v_old_values) o using (key)
     where n.value is distinct from o.value;
  end if;

  if exists (
    select 1
    from public.customer_automations a
    join public.customer_automation_versions v
      on v.id = a.active_version_id
     and v.customer_id = a.customer_id
    where a.customer_id = new.customer_id
      and a.status = 'Active'
      and v.trigger_type = 'contact.created'
      and (v.trigger_event_type = v_operation or v.trigger_event_type = 'created_or_updated')
  ) then
    v_lineage_root := nullif(current_setting('app.automation_root_event_id', true), '')::uuid;
    v_lineage_correlation := nullif(current_setting('app.automation_correlation_id', true), '')::uuid;
    v_lineage_depth := nullif(current_setting('app.automation_depth', true), '')::integer;

    insert into public.automation_events (
      customer_id, event_type, subject_id, operation, old_values, new_values, changed_fields, payload,
      root_event_id, correlation_id, depth
    ) values (
      new.customer_id,
      'contact.created',
      new.id,
      v_operation,
      v_old_values,
      v_new_values,
      v_changed_fields,
      jsonb_build_object('lead_id', new.lead_id, 'owner_id', new.owner_id),
      v_lineage_root,
      coalesce(v_lineage_correlation, gen_random_uuid()),
      coalesce(v_lineage_depth, 0)
    );
  end if;

  return new;
end;
$$;

create trigger contacts_enqueue_automation_event
  after insert or update on public.contacts
  for each row execute function public.enqueue_contact_automation_event();

revoke all on function public.enqueue_contact_automation_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Deactivate Lead (design note 3)
-- ---------------------------------------------------------------------

create or replace function public.deactivate_lead_via_automation(
  p_token text,
  p_customer_id uuid,
  p_lead_id uuid,
  p_automation_id uuid,
  p_automation_key text,
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
  v_lead_status text;
  v_updated_id uuid;
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

  -- 3. The lead must exist and belong to this tenant. Deactivating an
  --    already-Inactive lead is an idempotent no-op success, exactly
  --    like Task/Contact's own Deactivate — never an error.
  select status into v_lead_status
    from public.leads
   where id = p_lead_id and customer_id = p_customer_id;

  if not found then
    return 'invalid_lead';
  end if;

  -- LINEAGE (design note 3) — set unconditionally, exactly like
  -- update_lead_via_automation, since this write can re-fire
  -- leads_enqueue_automation_event regardless of the lead's prior state.
  perform set_config('app.automation_root_event_id', p_root_event_id::text, true);
  perform set_config('app.automation_correlation_id', p_correlation_id::text, true);
  perform set_config('app.automation_depth', (coalesce(p_depth, 0) + 1)::text, true);

  update public.leads
     set status = 'Inactive'
   where id = p_lead_id
     and customer_id = p_customer_id
  returning id into v_updated_id;

  if v_updated_id is null then
    return 'invalid_lead';
  end if;

  return 'deactivated';
end;
$$;

revoke all on function public.deactivate_lead_via_automation(text, uuid, uuid, uuid, text, uuid, uuid, integer) from public;
grant execute on function public.deactivate_lead_via_automation(text, uuid, uuid, uuid, text, uuid, uuid, integer) to anon, authenticated;

-- ---------------------------------------------------------------------
-- create_automation_task — lineage parameters added (design note 2).
-- Body otherwise byte-for-byte identical to 20260921120000's version;
-- only the signature and the three set_config calls before step 6's
-- INSERT are new.
-- ---------------------------------------------------------------------

drop function public.create_automation_task(text, uuid, uuid, uuid, text, text, text, text, text, date, text, uuid, uuid[]);

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
  p_round_robin_pool uuid[],
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
    return 'missing_idempotency_key';
  end if;

  if exists (
    select 1 from public.tasks
     where customer_id = p_customer_id
       and automation_key = p_automation_key
  ) then
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

  if not exists (
    select 1 from public.leads
     where id = p_lead_id
       and customer_id = p_customer_id
  ) then
    return 'invalid_lead';
  end if;

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

  -- LINEAGE (design note 2) — set unconditionally before the write that
  -- can now re-fire tasks_enqueue_automation_event.
  perform set_config('app.automation_root_event_id', p_root_event_id::text, true);
  perform set_config('app.automation_correlation_id', p_correlation_id::text, true);
  perform set_config('app.automation_depth', (coalesce(p_depth, 0) + 1)::text, true);

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
    return 'duplicate';
  end if;

  if p_assignment_mode = 'RoundRobin' then
    update public.customer_automations
       set last_assigned_to = v_assignee
     where id = p_automation_id
       and customer_id = p_customer_id;
  end if;

  return 'created';
end;
$$;

revoke all on function public.create_automation_task(text, uuid, uuid, uuid, text, text, text, text, text, date, text, uuid, uuid[], uuid, uuid, integer) from public;
grant execute on function public.create_automation_task(text, uuid, uuid, uuid, text, text, text, text, text, date, text, uuid, uuid[], uuid, uuid, integer) to anon, authenticated;

-- ---------------------------------------------------------------------
-- create_automation_contact — same treatment (design note 2).
-- ---------------------------------------------------------------------

drop function public.create_automation_contact(text, uuid, uuid, uuid, text, text, text, text, text, text, text, uuid, uuid[]);

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
  p_round_robin_pool uuid[],
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

  if exists (
    select 1 from public.contacts
     where customer_id = p_customer_id
       and automation_key = p_automation_key
  ) then
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

  if not exists (
    select 1 from public.leads
     where id = p_lead_id
       and customer_id = p_customer_id
  ) then
    return 'invalid_lead';
  end if;

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

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    return 'invalid_name';
  end if;

  -- LINEAGE (design note 2).
  perform set_config('app.automation_root_event_id', p_root_event_id::text, true);
  perform set_config('app.automation_correlation_id', p_correlation_id::text, true);
  perform set_config('app.automation_depth', (coalesce(p_depth, 0) + 1)::text, true);

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

  if p_assignment_mode = 'RoundRobin' then
    update public.customer_automations
       set last_assigned_to = v_assignee
     where id = p_automation_id
       and customer_id = p_customer_id;
  end if;

  return 'created';
end;
$$;

revoke all on function public.create_automation_contact(text, uuid, uuid, uuid, text, text, text, text, text, text, text, uuid, uuid[], uuid, uuid, integer) from public;
grant execute on function public.create_automation_contact(text, uuid, uuid, uuid, text, text, text, text, text, text, text, uuid, uuid[], uuid, uuid, integer) to anon, authenticated;

-- ---------------------------------------------------------------------
-- update_task_via_automation — lineage parameters added (design note 2).
-- ---------------------------------------------------------------------

drop function public.update_task_via_automation(text, uuid, text, uuid, text, text, text, text, date, text, text, boolean, text, uuid, uuid[]);

create or replace function public.update_task_via_automation(
  p_token text,
  p_customer_id uuid,
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
  p_round_robin_pool uuid[],
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
  v_task_activation text;
  v_task_id uuid;
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

  select id, activation_status into v_task_id, v_task_activation
    from public.tasks
   where automation_key = p_target_key and customer_id = p_customer_id;

  if not found then
    return 'target_not_found';
  end if;
  if v_task_activation <> 'Active' then
    return 'record_inactive';
  end if;

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

  -- LINEAGE (design note 2).
  perform set_config('app.automation_root_event_id', p_root_event_id::text, true);
  perform set_config('app.automation_correlation_id', p_correlation_id::text, true);
  perform set_config('app.automation_depth', (coalesce(p_depth, 0) + 1)::text, true);

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

revoke all on function public.update_task_via_automation(text, uuid, text, uuid, text, text, text, text, date, text, text, boolean, text, uuid, uuid[], uuid, uuid, integer) from public;
grant execute on function public.update_task_via_automation(text, uuid, text, uuid, text, text, text, text, date, text, text, boolean, text, uuid, uuid[], uuid, uuid, integer) to anon, authenticated;

-- ---------------------------------------------------------------------
-- update_contact_via_automation — lineage parameters added.
-- ---------------------------------------------------------------------

drop function public.update_contact_via_automation(text, uuid, text, uuid, text, text, text, text, text, text, boolean, text, uuid, uuid[]);

create or replace function public.update_contact_via_automation(
  p_token text,
  p_customer_id uuid,
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
  p_round_robin_pool uuid[],
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

  -- LINEAGE (design note 2).
  perform set_config('app.automation_root_event_id', p_root_event_id::text, true);
  perform set_config('app.automation_correlation_id', p_correlation_id::text, true);
  perform set_config('app.automation_depth', (coalesce(p_depth, 0) + 1)::text, true);

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

revoke all on function public.update_contact_via_automation(text, uuid, text, uuid, text, text, text, text, text, text, boolean, text, uuid, uuid[], uuid, uuid, integer) from public;
grant execute on function public.update_contact_via_automation(text, uuid, text, uuid, text, text, text, text, text, text, boolean, text, uuid, uuid[], uuid, uuid, integer) to anon, authenticated;

-- ---------------------------------------------------------------------
-- deactivate_task_via_automation / deactivate_contact_via_automation —
-- lineage parameters added.
-- ---------------------------------------------------------------------

drop function public.deactivate_task_via_automation(text, uuid, text, uuid, text);

create or replace function public.deactivate_task_via_automation(
  p_token text,
  p_customer_id uuid,
  p_target_key text,
  p_automation_id uuid,
  p_automation_key text,
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

  -- LINEAGE (design note 2) — set before the write regardless of
  -- whether a row actually matches, same as every other function here;
  -- a no-op UPDATE that matches nothing sets nothing off downstream
  -- either way.
  perform set_config('app.automation_root_event_id', p_root_event_id::text, true);
  perform set_config('app.automation_correlation_id', p_correlation_id::text, true);
  perform set_config('app.automation_depth', (coalesce(p_depth, 0) + 1)::text, true);

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

revoke all on function public.deactivate_task_via_automation(text, uuid, text, uuid, text, uuid, uuid, integer) from public;
grant execute on function public.deactivate_task_via_automation(text, uuid, text, uuid, text, uuid, uuid, integer) to anon, authenticated;

drop function public.deactivate_contact_via_automation(text, uuid, text, uuid, text);

create or replace function public.deactivate_contact_via_automation(
  p_token text,
  p_customer_id uuid,
  p_target_key text,
  p_automation_id uuid,
  p_automation_key text,
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

  perform set_config('app.automation_root_event_id', p_root_event_id::text, true);
  perform set_config('app.automation_correlation_id', p_correlation_id::text, true);
  perform set_config('app.automation_depth', (coalesce(p_depth, 0) + 1)::text, true);

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

revoke all on function public.deactivate_contact_via_automation(text, uuid, text, uuid, text, uuid, uuid, integer) from public;
grant execute on function public.deactivate_contact_via_automation(text, uuid, text, uuid, text, uuid, uuid, integer) to anon, authenticated;

commit;
