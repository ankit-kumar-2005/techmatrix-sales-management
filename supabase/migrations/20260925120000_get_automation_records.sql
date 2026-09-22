-- Automation Studio — Get Records, the query half of Phase 2's
-- collection-variable work (Loop needs no new SQL at all: it consumes a
-- collection Get Records already fetched, entirely in TypeScript).
--
-- =====================================================================
-- DESIGN NOTES — TENANT ISOLATION, READ IN FULL BEFORE TOUCHING THIS FILE
-- =====================================================================
--
-- This is the FIRST read-only, potentially-multi-row function this
-- engine has. Every write function up to now returns a single status
-- string for a single targeted row; this one can return up to
-- MAX_RECORDS_PER_QUERY whole rows, which is a genuinely different
-- shape of risk — a tenant-scoping mistake here does not fail one
-- write, it can hand back another tenant's data wholesale. The
-- guarantee this function gives, and exactly how each part of it holds:
--
-- 1. p_customer_id IS NEVER SUPPLIED BY THE WORKFLOW DEFINITION. The
--    TypeScript executor (registry/executors.ts's getRecords) passes
--    context.customerId, which is ALWAYS event.customer_id — the
--    CLAIMED event's own tenant, resolved by claim_automation_events
--    from the automation_events row itself, which in turn was written
--    by a trigger reading NEW.customer_id off a real row this
--    database already scoped by RLS/ownership when it was created.
--    There is no field anywhere in a Get Records node's stored config
--    (object, filters, limit, resultVariable — see definitions.ts) that
--    could carry a customer_id, so there is no path from "an admin's
--    saved workflow JSON" to this parameter at all — the exact same
--    guarantee every other function in this file already gives, not a
--    new one invented for this function.
--
-- 2. p_object NEVER BECOMES PART OF A SQL STRING. It is compared with
--    plain `=` against three fixed literals ('lead' | 'task' |
--    'contact'); each branch below is a COMPLETELY SEPARATE, fully
--    parameterized, hardcoded query naming a fixed table and a fixed
--    `where customer_id = p_customer_id`. There is no dynamic table
--    name, no dynamic column name, and no EXECUTE/format() call
--    anywhere in this function — which is what makes p_object
--    structurally unable to reach anything beyond "which of these three
--    fixed, already-tenant-scoped queries runs", never able to name a
--    table, a schema, or another tenant's row.
--
-- 3. THE SCAN ITSELF IS BOUNDED, NOT JUST THE RESULT. p_limit is
--    clamped server-side to MAX_RECORDS_PER_QUERY regardless of what
--    the caller asks for — the TypeScript executor already validates
--    this against the same constant (config/safeguards.ts), but a
--    privileged function must not depend on its caller having done so,
--    the same reasoning every write function's own re-validation
--    already follows.
--
-- 4. customer_id/id ARE STRIPPED FROM THE RETURNED JSON, the same
--    convention the trigger snapshots already use — customer_id is
--    redundant with the fact that every row returned already belongs to
--    p_customer_id by construction, and stripping it means a workflow
--    referencing `{{item.*}}` later can never be handed something that
--    reads like a second, competing tenant boundary.
--
-- 5. ORDERING IS FIXED (created_at desc, id — most recent first,
--    deterministic on ties), not caller-supplied — an orderable string
--    built from user input is its own injection surface this function
--    has no reason to open.
-- =====================================================================

begin;

create or replace function public.get_automation_records(
  p_token text,
  p_customer_id uuid,
  p_object text,
  p_limit integer
)
returns table (record_json jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
begin
  if not public.verify_automation_worker(p_token) then
    return;
  end if;

  -- Clamped, never trusted (design note 3). Also floors at 1 so a
  -- misconfigured or malicious 0/negative limit reads as "nothing", not
  -- as "no limit" — `limit -1` in Postgres would be a syntax error, but
  -- there is no reason to let a caller find that out.
  v_limit := greatest(1, least(coalesce(p_limit, 1), 200));

  if p_object = 'task' then
    return query
    select to_jsonb(t) - 'customer_id' - 'id'
      from public.tasks t
     where t.customer_id = p_customer_id
     order by t.created_at desc, t.id
     limit v_limit;
  elsif p_object = 'contact' then
    return query
    select to_jsonb(c) - 'customer_id' - 'id'
      from public.contacts c
     where c.customer_id = p_customer_id
     order by c.created_at desc, c.id
     limit v_limit;
  elsif p_object = 'lead' then
    return query
    select to_jsonb(l) - 'customer_id' - 'id'
      from public.leads l
     where l.customer_id = p_customer_id
     order by l.created_at desc, l.id
     limit v_limit;
  end if;
  -- Any other p_object value: falls through to returning zero rows,
  -- the same fail-closed shape an unauthorized token already gets —
  -- there is no `else raise exception`, so a caller cannot use the
  -- error channel to probe which object names this function recognizes.
end;
$$;

revoke all on function public.get_automation_records(text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.get_automation_records(text, uuid, text, integer) to anon, authenticated;

commit;
