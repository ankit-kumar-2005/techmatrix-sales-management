-- Adds customer_users.name to the two team-directory RPCs
-- (get_customer_team_directory, get_visible_team_directory) so the
-- Owner column, "All owners" filter, and Add/Edit Lead Owner picker can
-- show a person's actual name instead of falling back to email for
-- everyone. The name column itself already exists
-- (20260908120000_customer_and_user_names.sql) — neither RPC was ever
-- updated to select it, which is the entire reason owner UI has shown
-- email only up to now.
--
-- Design notes:
--   * CORRECTED after a first attempt at this migration failed against
--     the real database with: "ERROR: 42P13: cannot change return type
--     of existing function... Row type defined by OUT parameters is
--     different... Use DROP FUNCTION get_customer_team_directory()
--     first." That first attempt used a bare CREATE OR REPLACE to add
--     `name` to each RETURNS TABLE(...) list — this turns out NOT to be
--     allowed, unlike what an earlier version of these notes claimed.
--     PostgreSQL requires CREATE OR REPLACE FUNCTION's result row type
--     (RETURNS TABLE is sugar for a set of OUT parameters) to match
--     *exactly*, with no exception for appending a column at the end —
--     that earlier claim was simply wrong, corrected here based on the
--     actual error, not assumed. Both functions still take ZERO input
--     parameters (unchanged), so — unlike 20260908120000's
--     create_customer_with_admin() case, where the input arity itself
--     changed — there's no overload/ambiguity risk from an explicit
--     DROP + CREATE here: there is only ever one possible zero-argument
--     signature for either function name, so DROP FUNCTION
--     public.get_customer_team_directory() unambiguously targets the
--     one function that exists, no argument-type list required. DROP
--     removes the function's existing grant along with it (grants
--     attach to the specific catalog object, not the name) — both
--     `execute for authenticated` grants are reissued explicitly below,
--     identical to what 20260905170000 / 20260906120000 originally
--     granted. Because the failed first attempt's CREATE OR REPLACE
--     never succeeded (the whole transaction rolled back), neither
--     function was actually changed in the live database before this
--     corrected version — there's nothing "already partially done" to
--     account for.
--   * No other database object depends on either function — confirmed
--     by reviewing every migration in this project; both are called
--     only via supabase.rpc(...) from frontend code
--     (features/leads/lib/get-team-directory.ts), never referenced by a
--     trigger, view, RLS policy, or another function. Safe to drop.
--     Still worth confirming against the live database before applying
--     this (see supabase/PRE_MIGRATION_CHECKS.sql), since this
--     environment has no database connection to verify it directly.
--   * name is simply passed through as-is (nullable, exactly as stored)
--     — no fallback-to-email logic lives here. That's a display-layer
--     decision (a person with no name on file yet still needs to show
--     *something*), not a data-layer one; the frontend decides how to
--     present a null name, same as it already does for every other
--     nullable field this app surfaces.
--   * No RLS/security change: both functions still resolve the caller's
--     own customer strictly from auth.uid() internally, never from a
--     parameter, and still return only their own customer's roster
--     (or, for get_visible_team_directory, only the caller's own
--     downward hierarchy branch unless they're ADMIN) — identical to
--     before, just one more column per row.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

-- Zero-argument functions — DROP FUNCTION name() unambiguously targets
-- the one function that can possibly exist under that name, no
-- argument-type list needed. IF EXISTS makes this safe to re-run.
drop function if exists public.get_customer_team_directory();
drop function if exists public.get_visible_team_directory();

create or replace function public.get_customer_team_directory()
returns table (
  customer_user_id uuid,
  user_id uuid,
  email text,
  name text,
  role_name text,
  manager_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer_id uuid;
begin
  select cu.customer_id into v_customer_id
  from public.customer_users cu
  where cu.user_id = auth.uid()
    and cu.status = 'Active';

  if v_customer_id is null then
    return;
  end if;

  return query
    select cu.id, cu.user_id, u.email::text, cu.name, r.name, cu.manager_id, cu.status
    from public.customer_users cu
    join auth.users u on u.id = cu.user_id
    join public.roles r on r.id = cu.role_id
    where cu.customer_id = v_customer_id
      and cu.status = 'Active';
end;
$$;

create or replace function public.get_visible_team_directory()
returns table (
  customer_user_id uuid,
  user_id uuid,
  email text,
  name text,
  role_name text,
  manager_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer_id uuid;
  v_caller_cu_id uuid;
  v_role_name text;
begin
  select cu.customer_id, cu.id, r.name
    into v_customer_id, v_caller_cu_id, v_role_name
  from public.customer_users cu
  join public.roles r on r.id = cu.role_id
  where cu.user_id = auth.uid()
    and cu.status = 'Active';

  if v_customer_id is null then
    return;
  end if;

  if v_role_name = 'ADMIN' then
    return query
      select cu.id, cu.user_id, u.email::text, cu.name, r.name, cu.manager_id, cu.status
      from public.customer_users cu
      join auth.users u on u.id = cu.user_id
      join public.roles r on r.id = cu.role_id
      where cu.customer_id = v_customer_id
        and cu.status = 'Active';
    return;
  end if;

  return query
    with recursive descendants as (
      select cu.id, cu.manager_id
      from public.customer_users cu
      where cu.id = v_caller_cu_id
        and cu.customer_id = v_customer_id

      union all

      select cu.id, cu.manager_id
      from public.customer_users cu
      join descendants d on cu.manager_id = d.id
      where cu.customer_id = v_customer_id
    )
    select cu.id, cu.user_id, u.email::text, cu.name, r.name, cu.manager_id, cu.status
    from public.customer_users cu
    join auth.users u on u.id = cu.user_id
    join public.roles r on r.id = cu.role_id
    join descendants d on d.id = cu.id
    where cu.customer_id = v_customer_id
      and cu.status = 'Active';
end;
$$;

-- DROP removed both functions' previous grants along with the old
-- objects (a newly created function otherwise defaults to EXECUTE
-- granted to PUBLIC in Postgres — leaving these ungranted here would be
-- a real widening of access, not a no-op). Reissued identical to what
-- 20260905170000 / 20260906120000 originally granted: authenticated
-- only, nothing for anon or public.
revoke all on function public.get_customer_team_directory() from public;
grant execute on function public.get_customer_team_directory() to authenticated;

revoke all on function public.get_visible_team_directory() from public;
grant execute on function public.get_visible_team_directory() to authenticated;

commit;
