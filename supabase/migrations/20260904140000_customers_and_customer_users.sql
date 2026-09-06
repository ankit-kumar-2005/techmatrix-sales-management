-- Customers, customer users, roles, and leads.
--
-- Replaces the organizations/organization_members model from
-- 20260904120000_organizations_and_members.sql (created, then reverted by
-- 20260904130000_rollback_organizations_and_members.sql) per an updated
-- client requirement. New terminology throughout: customers /
-- customer_users / customer_id — organizations/organization_members/
-- organization_id are retired.
--
-- Design notes:
--   * role is a real reference table (roles), not a text column on
--     membership — customer_users.role_id is a foreign key. Exactly four
--     rows are seeded below: ADMIN, MANAGER, SENIOR_SALES_REP, SALES_REP.
--     There is no PRIMARY_ADMIN role: the Primary Admin is the
--     customer_users row where role = ADMIN *and* customers.created_by
--     matches that same user — a business concept, not a stored value.
--   * role_id (what role) and manager_id (who they report to) are
--     deliberately separate columns — a MANAGER can report to another
--     MANAGER or to the ADMIN; the schema doesn't conflate the two ideas.
--   * status is text, exactly 'Active' / 'Inactive' (never boolean, never
--     ACTIVE/INACTIVE, never enabled/disabled) — a hard client
--     requirement, enforced with a CHECK constraint on all four tables.
--     A future UI checkbox can still edit it (checked -> 'Active',
--     unchecked -> 'Inactive'); the storage format is fixed regardless
--     of the input widget. On leads this is distinct from `stage` (its
--     pipeline position — New/Contacted/Qualified/Proposal/Won): status
--     says whether the row itself is active or archived, stage says
--     where it is in the pipeline. Different questions, not merged.
--   * SAME-CUSTOMER SAFETY for manager_id and leads.owner_id: a plain
--     `manager_id uuid references customer_users(id)` only guarantees
--     the referenced row exists *somewhere* — not that it belongs to the
--     same customer. Both are enforced instead with a composite foreign
--     key against (customer_id, id) on customer_users, which requires a
--     supporting UNIQUE(customer_id, id) constraint (id alone is already
--     unique via the primary key, but Postgres still requires an
--     explicit unique constraint matching the exact FK target column
--     set). This makes "manager/owner from a different customer" a
--     constraint violation, not just an application-level convention.
--     ON DELETE SET NULL (<column>) — the PostgreSQL 15+ syntax for
--     nulling only specific columns of a multi-column FK — nulls only
--     manager_id/owner_id when the referenced row is deleted, never the
--     row's own customer_id (a plain, unqualified ON DELETE SET NULL on
--     a composite FK would null every FK column, including customer_id,
--     which would corrupt tenant isolation). Requires Postgres 15+;
--     confirm your Supabase project runs that or newer before applying.
--   * customer/membership creation is DELIBERATELY narrow: there is no
--     direct INSERT policy on customers or customer_users. The only way
--     to create either is create_customer_with_admin(), now SECURITY
--     DEFINER, so it can perform both inserts even though the calling
--     user has no INSERT privilege of their own. It independently
--     re-validates auth.uid() and the no-existing-membership rule inside
--     the function body — SECURITY DEFINER does not mean "trust the
--     input," it means "this is the only controlled door in." See the
--     security-decision note above the function below.
--   * RLS membership/admin checks (is_customer_member, is_customer_admin)
--     stay SECURITY DEFINER to avoid the classic self-referencing-RLS
--     recursion problem, and return only a boolean — no row data leaks.
--   * customers' SELECT policy allows created_by = auth.uid() as an
--     alternative to membership, to resolve the chicken-and-egg moment
--     right after creation, before any customer_users row exists yet.
--   * Table-level GRANTs are set explicitly rather than left at Supabase
--     project defaults: anon gets nothing on any of these four tables;
--     authenticated gets exactly the operations its RLS policies permit
--     (notably no INSERT grant on customers/customer_users at all) —
--     defense in depth alongside RLS, not instead of it.
--   * Hierarchy-aware visibility (a MANAGER seeing only their team's
--     leads) is intentionally NOT implemented in RLS yet — manager_id
--     supports it, but this phase only enforces customer-level isolation
--     plus a simple owner-or-admin check on leads. A deliberate,
--     documented follow-up, not an oversight.
--
-- Wrapped in an explicit transaction: a failure partway through rolls
-- back completely rather than leaving a partially-created schema.

begin;

-- ---------------------------------------------------------------------
-- roles — fixed reference data, four rows, managed only via migration
-- ---------------------------------------------------------------------

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.roles (name) values
  ('ADMIN'),
  ('MANAGER'),
  ('SENIOR_SALES_REP'),
  ('SALES_REP');

-- ---------------------------------------------------------------------
-- customers — the company/business using the application
-- ---------------------------------------------------------------------

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_name text,
  email text not null,
  phone text not null,
  website text,
  address text,
  city text,
  state text,
  country text,
  created_by uuid not null references auth.users (id) on delete restrict,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index customers_created_by_idx on public.customers (created_by);
create index customers_status_idx on public.customers (status);

-- ---------------------------------------------------------------------
-- customer_users — membership of a user in a customer, with role and
-- reporting hierarchy. unique(customer_id, id) supports the composite
-- same-customer-safe foreign keys below (this table's own manager_id,
-- and leads.owner_id).
-- ---------------------------------------------------------------------

create table public.customer_users (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete restrict,
  manager_id uuid,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_users_customer_user_key unique (customer_id, user_id),
  constraint customer_users_customer_id_key unique (customer_id, id),
  constraint customer_users_manager_same_customer_fkey
    foreign key (customer_id, manager_id)
    references public.customer_users (customer_id, id)
    on delete set null (manager_id)
);

create index customer_users_customer_id_idx on public.customer_users (customer_id);
create index customer_users_user_id_idx on public.customer_users (user_id);
create index customer_users_role_id_idx on public.customer_users (role_id);
create index customer_users_manager_id_idx on public.customer_users (manager_id);
create index customer_users_status_idx on public.customer_users (status);

-- ---------------------------------------------------------------------
-- leads — owner_id is same-customer-safe against customer_users via the
-- same composite-FK technique as manager_id above.
-- ---------------------------------------------------------------------

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  company text not null,
  contact_name text not null,
  deal_value numeric(12, 2) not null default 0 check (deal_value >= 0),
  stage text not null default 'New'
    check (stage in ('New', 'Contacted', 'Qualified', 'Proposal', 'Won','Lost')),
  owner_id uuid,
  source text,
  next_step text,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_owner_same_customer_fkey
    foreign key (customer_id, owner_id)
    references public.customer_users (customer_id, id)
    on delete set null (owner_id)
);

create index leads_customer_id_idx on public.leads (customer_id);
create index leads_owner_id_idx on public.leads (owner_id);
create index leads_status_idx on public.leads (status);
create index leads_stage_idx on public.leads (stage);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function public.set_updated_at();

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

create trigger customer_users_set_updated_at
  before update on public.customer_users
  for each row execute function public.set_updated_at();

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS helper functions (SECURITY DEFINER — see design notes above)
-- ---------------------------------------------------------------------

create or replace function public.is_customer_member(target_customer_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.customer_users cu
    where cu.customer_id = target_customer_id
      and cu.user_id = auth.uid()
      and cu.status = 'Active'
  );
$$;

create or replace function public.is_customer_admin(target_customer_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.customer_users cu
    join public.roles r on r.id = cu.role_id
    where cu.customer_id = target_customer_id
      and cu.user_id = auth.uid()
      and cu.status = 'Active'
      and r.name = 'ADMIN'
  );
$$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.roles enable row level security;
alter table public.customers enable row level security;
alter table public.customer_users enable row level security;
alter table public.leads enable row level security;

-- roles: read-only reference data — no insert/update/delete policy, so
-- RLS default-denies writes for every client role; the four rows are
-- managed only via migrations.
create policy "authenticated users can view roles"
  on public.roles for select
  to authenticated
  using (true);

-- customers: SELECT and UPDATE only. No INSERT policy — creation is
-- exclusively through create_customer_with_admin() (see below).
create policy "members or creators can view their customer"
  on public.customers for select
  to authenticated
  using (
    created_by = auth.uid()
    or public.is_customer_member(id)
  );

create policy "admins can update their customer"
  on public.customers for update
  to authenticated
  using (public.is_customer_admin(id))
  with check (public.is_customer_admin(id));

-- customer_users: SELECT only. No INSERT policy — the initial ADMIN
-- membership is created exclusively by create_customer_with_admin(); a
-- future invitation-acceptance flow gets its own narrow, separately
-- reviewed function rather than a broad direct INSERT policy here.
create policy "members can view relevant customer users"
  on public.customer_users for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_customer_member(customer_id)
  );

-- leads
create policy "customer members can view their customer's leads"
  on public.leads for select
  to authenticated
  using (public.is_customer_member(customer_id));

create policy "customer members can create leads for their customer"
  on public.leads for insert
  to authenticated
  with check (public.is_customer_member(customer_id));

create policy "owners or admins can update a lead"
  on public.leads for update
  to authenticated
  using (
    public.is_customer_admin(customer_id)
    or owner_id in (
      select cu.id from public.customer_users cu
      where cu.user_id = auth.uid()
        and cu.customer_id = leads.customer_id
        and cu.status = 'Active'
    )
  )
  with check (
    public.is_customer_admin(customer_id)
    or owner_id in (
      select cu.id from public.customer_users cu
      where cu.user_id = auth.uid()
        and cu.customer_id = leads.customer_id
        and cu.status = 'Active'
    )
  );

-- ---------------------------------------------------------------------
-- Explicit table grants (defense in depth alongside RLS — a GRANT and a
-- matching policy are both required for PostgREST to allow an
-- operation; neither alone is enough, and we don't rely on Supabase's
-- broader project-level defaults for these four tables).
-- ---------------------------------------------------------------------

revoke all on public.roles from anon, authenticated;
grant select on public.roles to authenticated;

revoke all on public.customers from anon, authenticated;
grant select, update on public.customers to authenticated;

revoke all on public.customer_users from anon, authenticated;
grant select on public.customer_users to authenticated;

revoke all on public.leads from anon, authenticated;
grant select, insert, update on public.leads to authenticated;

-- ---------------------------------------------------------------------
-- create_customer_with_admin: the only door into customers/
-- customer_users creation.
--
-- SECURITY DECISION: this is SECURITY DEFINER, not INVOKER. There is no
-- INSERT policy on customers or customer_users (above) and no INSERT
-- grant on either table (above either) — a caller has no privilege of
-- their own to insert into these tables at all. This function runs with
-- the definer's privilege specifically so it CAN perform both inserts
-- despite that, while remaining the only path that can. Safety measures
-- that make this sound:
--   * `set search_path = public` pins name resolution so a caller can't
--     shadow public.customers/public.roles/etc. with objects in another
--     schema to redirect what this function actually touches.
--   * auth.uid() is re-validated inside the function (not trusted from
--     a parameter — no customer/user id is ever accepted as input here)
--     and the function raises if it's null.
--   * the "already belongs to a customer" check is re-verified here,
--     independent of any check the caller's client code may or may not
--     have done — this function is the enforcement point, not a
--     convenience wrapper around one.
--   * it inserts exactly two rows (one customers row, one ADMIN
--     customer_users row for auth.uid() specifically) and nothing else
--     — it cannot be used to insert arbitrary data into either table.
--   * it returns the created customers row (needed by the caller to
--     redirect/display it) and nothing beyond that — no other table's
--     data, no internal state.
--   * only `authenticated` may execute it (granted below); `anon` and
--     `public` cannot call it at all.
-- ---------------------------------------------------------------------

create or replace function public.create_customer_with_admin(
  p_email text,
  p_phone text,
  p_company_name text default null,
  p_website text default null,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_admin_role_id uuid;
  v_customer public.customers;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.customer_users where user_id = v_user_id) then
    raise exception 'User already belongs to a customer';
  end if;

  select id into v_admin_role_id from public.roles where name = 'ADMIN';
  if v_admin_role_id is null then
    raise exception 'ADMIN role is not configured';
  end if;

  insert into public.customers (company_name, email, phone, created_by, website, address, city, state, country)
  values (p_company_name, p_email, p_phone, v_user_id, p_website, p_address, p_city, p_state, p_country)
  returning * into v_customer;

  insert into public.customer_users (customer_id, user_id, role_id, status)
  values (v_customer.id, v_user_id, v_admin_role_id, 'Active');

  return v_customer;
end;
$$;

revoke all on function public.create_customer_with_admin from public;
grant execute on function public.create_customer_with_admin to authenticated;

commit;
