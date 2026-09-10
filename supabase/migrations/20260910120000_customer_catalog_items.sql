-- Product & Service Catalog: each customer's own list of sellable
-- items (what they sell, with pricing a rep can attach to a proposal —
-- the proposal-attachment part is future scope; this migration only
-- creates the catalog data itself and its access rules).
--
-- Design notes:
--   * customer_catalog_items follows the exact same shape/relationship
--     as customer_lead_stages (20260907120000): one row per customer-
--     owned configurable item, customer_id -> customers(id), RLS scoped
--     via the SAME existing is_customer_member/is_customer_admin
--     SECURITY DEFINER helpers from 20260904140000 — no new helper
--     functions needed, no new tenant/role concept introduced.
--   * NO DELETE policy or grant, deliberately — the same choice already
--     made for customer_lead_stages, for the same reason: once a future
--     feature lets a rep attach a catalog item to a lead/proposal, a
--     hard DELETE would either orphan that reference or require an ON
--     DELETE behavior decision made under pressure later. `status`
--     ('Active'/'Inactive') is the deactivation mechanism instead, so a
--     retired item can disappear from new-proposal selection without
--     ever breaking a historical reference. An UPDATE policy exists
--     (admin-only) so status changes — and a future "Edit" UI — have
--     something to call; no edit/delete UI is built in this pass, since
--     neither appears in the reference screenshots and the task
--     explicitly asked not to invent UI beyond what's shown.
--   * price is numeric(12,2) — matches leads.deal_value's precision
--     exactly — with a CHECK (price >= 0), same non-negative pattern
--     used there. Never stored as a formatted string; ₹-formatting is
--     display-only, in the frontend (see utils/format.ts's existing
--     currencyFormatter, reused as-is).
--   * pricing_unit is a plain text CHECK-constrained column (One-time /
--     Per month / Starting at), not a separate lookup table — there's
--     no customer-configurability requirement for this list (unlike
--     lead stages, which are deliberately customer-editable), so a
--     fixed CHECK is the simpler, sufficient choice, consistent with
--     how this project already uses CHECK constraints for small fixed
--     vocabularies (e.g. status columns).
--   * created_by is nullable with ON DELETE SET NULL, matching the
--     leads.owner_id / customer_users.manager_id pattern already in
--     this project: an audit-trail reference that should never block or
--     cascade-delete anything if the referenced auth user is ever
--     removed.
--   * updated_at is maintained by the existing shared set_updated_at()
--     trigger function (defined once in 20260904140000, already reused
--     by every mutable table since) — not redefined here.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

create table public.customer_catalog_items (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  name text not null,
  category text not null,
  price numeric(12, 2) not null check (price >= 0),
  pricing_unit text not null check (pricing_unit in ('One-time', 'Per month', 'Starting at')),
  description text,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_catalog_items_name_not_blank check (btrim(name) <> ''),
  constraint customer_catalog_items_category_not_blank check (btrim(category) <> '')
);

create index customer_catalog_items_customer_id_idx on public.customer_catalog_items (customer_id);
create index customer_catalog_items_status_idx on public.customer_catalog_items (status);

create trigger customer_catalog_items_set_updated_at
  before update on public.customer_catalog_items
  for each row execute function public.set_updated_at();

alter table public.customer_catalog_items enable row level security;

create policy "customer members can view their customer's catalog items"
  on public.customer_catalog_items for select
  to authenticated
  using (public.is_customer_member(customer_id));

create policy "admins can create catalog items for their customer"
  on public.customer_catalog_items for insert
  to authenticated
  with check (public.is_customer_admin(customer_id));

create policy "admins can update their customer's catalog items"
  on public.customer_catalog_items for update
  to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

-- No DELETE policy/grant at all — see design notes above.
revoke all on public.customer_catalog_items from anon, authenticated;
grant select, insert, update on public.customer_catalog_items to authenticated;

commit;
