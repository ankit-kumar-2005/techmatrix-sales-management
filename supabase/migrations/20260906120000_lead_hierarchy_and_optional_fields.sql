-- Hierarchy-aware lead visibility/ownership + optional lead fields.
--
-- This is the deliberate follow-up flagged in
-- 20260904140000_customers_and_customer_users.sql: "Hierarchy-aware
-- visibility (a MANAGER seeing only their team's leads) is intentionally
-- NOT implemented in RLS yet — manager_id supports it, but this phase
-- only enforces customer-level isolation plus a simple owner-or-admin
-- check on leads." That phase is now.
--
-- Design notes:
--   * ROLE hierarchy (ADMIN > MANAGER > SENIOR_SALES_REP > SALES_REP) and
--     REPORTING hierarchy (customer_users.manager_id) are different
--     things. Visibility here is driven entirely by the reporting chain,
--     not by comparing role names — a MANAGER sees exactly their own
--     recursive manager_id subtree, never "everyone who is a MANAGER or
--     below." Two different MANAGERs under the same ADMIN cannot see
--     each other's branches.
--   * is_customer_user_visible(target): the one new authorization
--     primitive. ADMIN -> true for anyone in their own customer.
--     Everyone else -> true only for themselves or a recursive
--     manager_id descendant of themselves, within their own customer.
--     SECURITY DEFINER + set search_path = public, same pattern as
--     is_customer_member/is_customer_admin above it — this only reads
--     customer_users/roles (never leads), so it cannot recurse back into
--     the leads RLS policies that call it.
--   * This is deliberately a DOWNWARD-only visibility check (self +
--     descendants), used only for leads.owner_id authorization. It does
--     NOT touch the existing, broader "any active member can see any
--     other member of their customer" policy on customer_users, and does
--     NOT touch get_customer_team_directory() — that RPC is still used
--     by the Profile page to resolve the CALLER's OWN manager (an
--     ancestor, not a descendant), which a downward-only visibility rule
--     would break. Narrowing customer_users visibility itself, or
--     general team-directory browsing, is a separate concern this
--     migration does not touch.
--   * get_visible_team_directory(): a NEW, narrower sibling RPC built on
--     the same downward-only rule, for the two UI surfaces that must
--     respect hierarchy specifically — the Pipeline "Owner" filter and
--     the Create Lead "Owner" picker (ADMIN only). ADMIN gets everyone
--     in the customer (matching "ADMIN can assign to any active user in
--     their org"); everyone else gets self + recursive descendants.
--   * leads SELECT policy becomes: admin of that customer, OR the lead
--     has a non-null owner_id that is_customer_user_visible to the
--     caller. An unassigned lead (owner_id is null) is visible only to
--     an ADMIN — nobody's "team" includes "nobody," and only ADMIN can
--     assign an owner anyway (see the INSERT policy below), so ADMIN is
--     the only role that ever needs to see/act on an unassigned lead.
--   * leads INSERT policy gains a real, server-independent backstop for
--     "non-admins cannot assign a lead to anyone but themselves": the
--     WITH CHECK now requires owner_id to equal the caller's own
--     customer_users.id whenever the caller is not an admin. This holds
--     even if a caller bypasses the app's Server Action and calls
--     Supabase directly with a hand-crafted owner_id. ADMIN keeps full
--     flexibility (any owner_id valid for their customer, including
--     null) via the composite same-customer-safe FK already in place.
--   * leads UPDATE policy is intentionally UNCHANGED — this migration
--     only adds hierarchy-aware VIEW access and owner-assignment
--     authorization on CREATE, exactly what was requested. It does not
--     grant a MANAGER/SENIOR_SALES_REP edit rights over their team's
--     leads' other fields — that's a distinct, separately-scoped
--     decision, not implied by "can see their team's pipeline."
--   * company/deal_value become nullable (empty means "not provided,"
--     never coerced to 0/""), and email/phone are added as plain
--     nullable text columns — no new constraints on either, matching
--     "OPTIONAL" in the lead field spec.
--   * ONE ACTIVE MEMBERSHIP PER USER: the app has always assumed one
--     authenticated user -> one active customer_users row -> one
--     customer (every membership lookup in this codebase does
--     "where user_id = auth.uid() and status = 'Active'" and treats the
--     result as *the* membership). That was previously only encouraged
--     by create_customer_with_admin()'s own "already belongs to a
--     customer" check — never a real constraint, so nothing stopped a
--     second ACTIVE row (in a different customer) from existing via any
--     other insert path. A partial unique index enforces it for real:
--     unique on (user_id) WHERE status = 'Active'. Deliberately not a
--     plain unique(user_id), which would also forbid keeping past
--     INACTIVE memberships around. This also means every "resolve the
--     caller's active membership" lookup below (and in
--     20260905170000_team_directory_and_avatars.sql, which predates this
--     invariant) can safely drop LIMIT 1 — with the index in place,
--     "arbitrarily picking a row via LIMIT 1" is no longer a real
--     possibility, since the database itself guarantees at most one row
--     can ever match. A zero-membership caller still resolves to no
--     row (NULL), not an error.
--   * SELF-MANAGER PROTECTION: a customer_users row must never name
--     itself as its own manager_id — a plain CHECK constraint, since
--     that invariant is a property of a single row, not something a
--     partial index can express.
--   * OWNER_ID UPDATE PROTECTION: the existing "owners or admins can
--     update a lead" policy (20260904140000, untouched) already limits
--     *which* leads a non-admin can update at all, but that's a
--     different question from "which columns may change once they're
--     updating one." A BEFORE UPDATE trigger
--     (protect_lead_owner_id_change) is the backstop specifically for
--     owner_id: if it's changing at all, the caller must be an admin of
--     that lead's customer, full stop — independent of, and more
--     durable than, the RLS owner-matching pattern (which would stop
--     enforcing this the moment UPDATE authorization is ever broadened
--     to let a MANAGER edit their team's leads). Not SECURITY DEFINER —
--     same reasoning as customers_prevent_email_change in
--     20260905160000: it only calls the already-SECURITY-DEFINER
--     is_customer_admin() and needs no elevated privilege of its own.
--
-- Wrapped in a transaction like the prior lead-related migrations.

begin;

-- ---------------------------------------------------------------------
-- Optional lead fields
-- ---------------------------------------------------------------------

alter table public.leads
  alter column company drop not null;

alter table public.leads
  alter column deal_value drop not null,
  alter column deal_value drop default;

alter table public.leads
  add column email text,
  add column phone text;

-- ---------------------------------------------------------------------
-- customer_users invariants: one active membership per user, and a
-- customer_user can never be its own manager.
-- ---------------------------------------------------------------------

create unique index customer_users_one_active_membership_per_user
  on public.customer_users (user_id)
  where status = 'Active';

alter table public.customer_users
  add constraint customer_users_manager_not_self
  check (manager_id is null or manager_id <> id);

-- ---------------------------------------------------------------------
-- Hierarchy-aware visibility (downward-only: self + recursive
-- manager_id descendants; ADMIN sees the whole customer)
-- ---------------------------------------------------------------------

create or replace function public.is_customer_user_visible(target_customer_user_id uuid)
returns boolean
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
  if target_customer_user_id is null then
    return false;
  end if;

  -- Exactly one row can ever match here (customer_users_one_active_
  -- membership_per_user) — no LIMIT 1 needed to pick among candidates
  -- that, by construction, cannot exist.
  select cu.customer_id, cu.id, r.name
    into v_customer_id, v_caller_cu_id, v_role_name
  from public.customer_users cu
  join public.roles r on r.id = cu.role_id
  where cu.user_id = auth.uid()
    and cu.status = 'Active';

  if v_customer_id is null then
    return false;
  end if;

  if not exists (
    select 1 from public.customer_users t
    where t.id = target_customer_user_id
      and t.customer_id = v_customer_id
  ) then
    return false;
  end if;

  if v_role_name = 'ADMIN' then
    return true;
  end if;

  if target_customer_user_id = v_caller_cu_id then
    return true;
  end if;

  return exists (
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
    select 1 from descendants where id = target_customer_user_id
  );
end;
$$;

revoke all on function public.is_customer_user_visible from public;
grant execute on function public.is_customer_user_visible to authenticated;

create or replace function public.get_visible_team_directory()
returns table (
  customer_user_id uuid,
  user_id uuid,
  email text,
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
      select cu.id, cu.user_id, u.email::text, r.name, cu.manager_id, cu.status
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
    select cu.id, cu.user_id, u.email::text, r.name, cu.manager_id, cu.status
    from public.customer_users cu
    join auth.users u on u.id = cu.user_id
    join public.roles r on r.id = cu.role_id
    join descendants d on d.id = cu.id
    where cu.customer_id = v_customer_id
      and cu.status = 'Active';
end;
$$;

revoke all on function public.get_visible_team_directory from public;
grant execute on function public.get_visible_team_directory to authenticated;

-- ---------------------------------------------------------------------
-- leads RLS: hierarchy-aware SELECT, owner-authorized INSERT
-- ---------------------------------------------------------------------

drop policy "customer members can view their customer's leads" on public.leads;

create policy "hierarchy-aware lead visibility"
  on public.leads for select
  to authenticated
  using (
    public.is_customer_admin(customer_id)
    or (owner_id is not null and public.is_customer_user_visible(owner_id))
  );

drop policy "customer members can create leads for their customer" on public.leads;

create policy "members create leads owned by themselves, admins by anyone"
  on public.leads for insert
  to authenticated
  with check (
    public.is_customer_member(customer_id)
    and (
      public.is_customer_admin(customer_id)
      or owner_id = (
        select cu.id from public.customer_users cu
        where cu.user_id = auth.uid()
          and cu.customer_id = leads.customer_id
          and cu.status = 'Active'
      )
    )
  );

-- ---------------------------------------------------------------------
-- leads UPDATE: owner_id is admin-only to change, regardless of what
-- the existing "owners or admins can update a lead" policy
-- (20260904140000) otherwise allows a non-admin to touch on a lead
-- they're authorized to update.
-- ---------------------------------------------------------------------

create or replace function public.protect_lead_owner_id_change()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    if not public.is_customer_admin(old.customer_id) then
      raise exception 'Only an admin may change a lead''s owner.';
    end if;
  end if;
  return new;
end;
$$;

create trigger leads_protect_owner_id_change
  before update on public.leads
  for each row
  execute function public.protect_lead_owner_id_change();

commit;
