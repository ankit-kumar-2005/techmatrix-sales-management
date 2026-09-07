-- Dynamic, customer-configurable lead stages + closed-lead locking +
-- inactive-stage protection.
--
-- Replaces the fixed `leads.stage` text/CHECK column (New/Contacted/
-- Qualified/Proposal/Won/Lost) with a real per-customer table,
-- `customer_lead_stages`, and a `leads.stage_id` foreign key into it.
-- Those six names become nothing more than the default rows seeded for
-- every customer — an ADMIN can rename, reorder, deactivate, or add any
-- stage their business needs, with zero code/migration/deploy required
-- per stage.
--
-- Design notes:
--   * customer_lead_stages mirrors the same same-customer-safety pattern
--     already used for customer_users.manager_id and leads.owner_id: a
--     composite UNIQUE(customer_id, id) backs a composite FK from
--     leads(customer_id, stage_id), so a lead can never reference
--     another customer's stage — enforced by the database, not just
--     application code.
--   * Stage name uniqueness is per-customer and case/whitespace
--     insensitive (a partial-looking "Negotiation" / " negotiation " /
--     "NEGOTIATION" collision is still a collision) via a functional
--     unique index on (customer_id, lower(btrim(stage))). Two different
--     customers can both have "Negotiation" — the index only scopes
--     within one customer_id. Globally unique names are NOT required.
--   * is_closed is the ONLY thing that determines whether a lead is
--     locked — never a name comparison like stage = 'Won'. Multiple
--     closed stages are fully supported (Won, Lost, Cancelled, Contract
--     Signed, whatever a given customer defines). Deliberately NO
--     is_won/similar semantic flag — that's an explicit decision to keep
--     this table to exactly the columns required right now; if a future
--     KPI needs to distinguish a closed-won stage from a closed-lost
--     one, that's a separate, later change.
--   * Stages are never hard-deleted (no DELETE policy/grant at all) —
--     only deactivated (status = 'Inactive'), so historical leads always
--     keep a valid, resolvable stage_id and their stage name/color never
--     disappears from List/Board views even after an admin retires that
--     stage from new-lead selection.
--   * create_customer_with_admin() is extended (via CREATE OR REPLACE —
--     not editing the historical migration file that first defined it)
--     to seed the six default stages atomically in the same transaction
--     as customer creation, so a customer can never exist without a
--     usable stage set. Existing customers already in the database are
--     backfilled once, idempotently, below.
--   * LEAD STAGE/LOCK TRIGGER: protect_lead_stage_transition() is a
--     single BEFORE INSERT OR UPDATE trigger that owns three related
--     rules together (splitting them into separate triggers would only
--     make their firing order/interaction harder to reason about):
--       1. Once a lead is closed (OLD.closed_at is not null on an
--          UPDATE), the entire statement is rejected — every column, not
--          just stage/owner. This is what makes a closed lead read-only
--          for every role, including ADMIN, with no path to reopen it
--          through a normal update. Changing a stage's own is_closed
--          flag later (e.g. an admin un-marks "Won" as closed) cannot
--          reopen an already-closed lead, because this check only looks
--          at the lead's own closed_at, never at the stage's current
--          configuration.
--       2. Whenever stage_id is being set (every INSERT, or an UPDATE
--          where NEW.stage_id IS DISTINCT FROM OLD.stage_id), the target
--          stage must belong to the same customer and must be Active —
--          both checked explicitly here (not left to the composite FK
--          alone) so a rejection is a clean, specific exception instead
--          of a raw constraint-violation error surfaced to the end user.
--          An UPDATE that leaves stage_id unchanged skips this check
--          entirely, so an existing lead already sitting on a
--          since-deactivated stage remains valid and editable (other
--          fields) rather than becoming stuck.
--       3. closed_at is computed here, server-side, on every INSERT and
--          every UPDATE — never trusted from client input. When stage_id
--          is part of the write (INSERT, or an UPDATE that changes it),
--          closed_at is set to now() if the resolved target stage is
--          closed, else NULL. When an UPDATE leaves stage_id unchanged,
--          NEW.closed_at is forced back to OLD.closed_at — Postgres
--          otherwise defaults NEW.closed_at to whatever the client's
--          UPDATE payload contained for any column this trigger doesn't
--          explicitly overwrite, so that branch is required, not
--          optional, to keep closed_at fully server-controlled.
--     Not SECURITY DEFINER: its own SELECT against customer_lead_stages
--     runs as the calling (authenticated) role, which means RLS's
--     existing "customer members can view their customer's lead stages"
--     policy is what makes a cross-customer stage_id invisible to this
--     lookup in the first place — the trigger's own customer_id check
--     and RLS reinforce each other for free, with no need to bypass RLS
--     to enforce this.
--   * The existing "owners or admins can update a lead" RLS policy
--     (20260904140000) is redefined here (drop + recreate, same name,
--     same owner-or-admin logic) to additionally require closed_at IS
--     NULL in its USING clause — a second, independent layer alongside
--     the trigger above, that holds even if this trigger were ever
--     bypassed (e.g. a future SECURITY DEFINER write path). USING sees
--     only the OLD row, so this doesn't block the legitimate
--     open->closed transition itself (that update's OLD.closed_at is
--     still null). The INSERT policy needs no change: it already scopes
--     customer_id/owner_id correctly, and stage validity is entirely the
--     trigger's job per its own design above.
--   * MIGRATION SAFETY: every existing lead's `stage` value is mapped to
--     the newly-seeded customer_lead_stages row with a matching name
--     (case/whitespace-insensitive) for its own customer. If any lead
--     cannot be mapped this way, the migration aborts with a clear
--     exception rather than silently assigning an arbitrary fallback
--     stage — in practice this should never fire, since the CHECK
--     constraint being dropped only ever allowed the six exact seeded
--     names, but the safety net is unconditional regardless.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

-- ---------------------------------------------------------------------
-- customer_lead_stages
-- ---------------------------------------------------------------------

create table public.customer_lead_stages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  stage text not null,
  display_order integer not null,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  is_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_lead_stages_customer_id_key unique (customer_id, id),
  constraint customer_lead_stages_stage_not_blank check (btrim(stage) <> '')
);

-- Case/whitespace-insensitive uniqueness, scoped per customer.
create unique index customer_lead_stages_unique_name_per_customer
  on public.customer_lead_stages (customer_id, lower(btrim(stage)));

create index customer_lead_stages_customer_id_idx on public.customer_lead_stages (customer_id);
create index customer_lead_stages_display_order_idx on public.customer_lead_stages (customer_id, display_order);
create index customer_lead_stages_status_idx on public.customer_lead_stages (status);

create trigger customer_lead_stages_set_updated_at
  before update on public.customer_lead_stages
  for each row execute function public.set_updated_at();

alter table public.customer_lead_stages enable row level security;

create policy "customer members can view their customer's lead stages"
  on public.customer_lead_stages for select
  to authenticated
  using (public.is_customer_member(customer_id));

create policy "admins can create lead stages for their customer"
  on public.customer_lead_stages for insert
  to authenticated
  with check (public.is_customer_admin(customer_id));

create policy "admins can update their customer's lead stages"
  on public.customer_lead_stages for update
  to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

-- No DELETE policy/grant at all — stages are deactivated, never deleted,
-- so a lead's stage_id is always resolvable.
revoke all on public.customer_lead_stages from anon, authenticated;
grant select, insert, update on public.customer_lead_stages to authenticated;

-- ---------------------------------------------------------------------
-- Backfill: seed the six default stages for every customer that
-- doesn't already have any (every existing customer, on first run of
-- this migration; a no-op if ever re-run). Idempotent via the
-- NOT EXISTS guard, not ON CONFLICT — there is no natural key yet for
-- a customer that has zero stage rows.
-- ---------------------------------------------------------------------

insert into public.customer_lead_stages (customer_id, stage, display_order, status, is_closed)
select c.id, s.stage, s.display_order, 'Active', s.is_closed
from public.customers c
cross join (
  values
    ('New', 1, false),
    ('Contacted', 2, false),
    ('Qualified', 3, false),
    ('Proposal', 4, false),
    ('Won', 5, true),
    ('Lost', 6, true)
) as s(stage, display_order, is_closed)
where not exists (
  select 1 from public.customer_lead_stages cls where cls.customer_id = c.id
);

-- ---------------------------------------------------------------------
-- create_customer_with_admin(): seed the same six default stages for
-- every NEW customer going forward, atomically in the same transaction
-- as customer + admin-membership creation. Signature, SECURITY DEFINER,
-- search_path, auth checks, and return value are all identical to the
-- original (20260904140000) — the only addition is the stage-seeding
-- insert at the end.
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

  insert into public.customer_lead_stages (customer_id, stage, display_order, status, is_closed)
  values
    (v_customer.id, 'New', 1, 'Active', false),
    (v_customer.id, 'Contacted', 2, 'Active', false),
    (v_customer.id, 'Qualified', 3, 'Active', false),
    (v_customer.id, 'Proposal', 4, 'Active', false),
    (v_customer.id, 'Won', 5, 'Active', true),
    (v_customer.id, 'Lost', 6, 'Active', true);

  return v_customer;
end;
$$;

-- ---------------------------------------------------------------------
-- leads.stage_id: migrate the fixed text `stage` column into a real,
-- customer-safe foreign key. Existing rows are mapped by case/
-- whitespace-insensitive name match against the default stages just
-- seeded above. If any lead cannot be mapped this way, the migration
-- aborts (raises, rolling back the whole transaction) rather than
-- silently assigning an arbitrary stage.
-- ---------------------------------------------------------------------

alter table public.leads add column stage_id uuid;

update public.leads l
set stage_id = cls.id
from public.customer_lead_stages cls
where cls.customer_id = l.customer_id
  and lower(btrim(cls.stage)) = lower(btrim(l.stage));

do $$
declare
  v_unmapped_count integer;
begin
  select count(*) into v_unmapped_count from public.leads where stage_id is null;
  if v_unmapped_count > 0 then
    raise exception
      'Migration aborted: % lead(s) could not be mapped to a customer_lead_stages row. '
      'Every existing leads.stage value must exactly match (case/whitespace-insensitively) '
      'one of the seeded default stage names for its own customer before this migration can proceed.',
      v_unmapped_count;
  end if;
end;
$$;

alter table public.leads alter column stage_id set not null;

alter table public.leads
  add constraint leads_stage_same_customer_fkey
  foreign key (customer_id, stage_id)
  references public.customer_lead_stages (customer_id, id)
  on delete restrict;

-- Drops the column's own CHECK constraint and the old leads_stage_idx
-- (defined on this column) along with it — no separate DROP needed.
alter table public.leads drop column stage;

create index leads_stage_id_idx on public.leads (stage_id);

-- ---------------------------------------------------------------------
-- leads.whatsapp_phone, leads.closed_at
-- ---------------------------------------------------------------------

alter table public.leads
  add column whatsapp_phone text,
  add column closed_at timestamptz;

-- Backfill: any existing lead already sitting in a stage that is now
-- flagged is_closed = true (i.e. every existing Won/Lost lead) is
-- treated as already closed as of this migration — closed_at set to
-- its own updated_at as the best available estimate of when that
-- happened, since the exact historical moment isn't recorded anywhere.
update public.leads l
set closed_at = l.updated_at
from public.customer_lead_stages cls
where cls.id = l.stage_id
  and cls.is_closed = true
  and l.closed_at is null;

-- ---------------------------------------------------------------------
-- Lead stage transition guard: closed-lead lock + inactive-stage
-- protection + server-computed closed_at (see design notes above).
-- ---------------------------------------------------------------------

create or replace function public.protect_lead_stage_transition()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_target_customer_id uuid;
  v_target_status text;
  v_target_is_closed boolean;
begin
  if TG_OP = 'UPDATE' and old.closed_at is not null then
    raise exception 'This lead is closed and cannot be modified.';
  end if;

  -- Only re-validate the target stage when it's actually part of this
  -- write (every INSERT; an UPDATE only when stage_id is changing) — an
  -- UPDATE that leaves stage_id untouched must not be blocked just
  -- because that stage has since been deactivated.
  if TG_OP = 'INSERT' or new.stage_id is distinct from old.stage_id then
    select cls.customer_id, cls.status, cls.is_closed
      into v_target_customer_id, v_target_status, v_target_is_closed
    from public.customer_lead_stages cls
    where cls.id = new.stage_id;

    if v_target_customer_id is null then
      -- Either the stage genuinely doesn't exist, or it belongs to
      -- another customer and RLS on customer_lead_stages already hid it
      -- from this (non-SECURITY-DEFINER) lookup — both cases are
      -- correctly rejected identically here.
      raise exception 'Selected stage does not exist.';
    end if;

    if v_target_customer_id is distinct from new.customer_id then
      raise exception 'Selected stage does not belong to your customer.';
    end if;

    if v_target_status is distinct from 'Active' then
      raise exception 'Selected stage is not active and cannot be assigned to a lead.';
    end if;

    if v_target_is_closed then
      new.closed_at := now();
    else
      new.closed_at := null;
    end if;
  elsif TG_OP = 'UPDATE' then
    -- stage_id isn't part of this write: closed_at must not move at all,
    -- so it's forced back to its current value rather than left as
    -- whatever the client's UPDATE payload happened to contain. Without
    -- this branch NEW.closed_at silently defaults to the client-supplied
    -- value for any column Postgres's row-level trigger doesn't
    -- explicitly overwrite — this line is what closes that gap.
    new.closed_at := old.closed_at;
  end if;

  return new;
end;
$$;

create trigger leads_protect_stage_transition
  before insert or update on public.leads
  for each row
  execute function public.protect_lead_stage_transition();

-- Redefine the existing UPDATE policy (same name, same owner-or-admin
-- logic) to additionally require the row isn't already closed. This is
-- a second, independent layer alongside the trigger above — USING sees
-- only the OLD row, so it never blocks the legitimate open->closed
-- transition itself (that update's OLD.closed_at is still null).
drop policy "owners or admins can update a lead" on public.leads;

create policy "owners or admins can update a lead"
  on public.leads for update
  to authenticated
  using (
    closed_at is null
    and (
      public.is_customer_admin(customer_id)
      or owner_id in (
        select cu.id from public.customer_users cu
        where cu.user_id = auth.uid()
          and cu.customer_id = leads.customer_id
          and cu.status = 'Active'
      )
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

commit;
