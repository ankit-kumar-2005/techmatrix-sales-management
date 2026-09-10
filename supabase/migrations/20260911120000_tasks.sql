-- Tasks & Reminders — a Task is always linked to exactly one Lead, never
-- standalone. No new tenant model, no new role/permission system, no new
-- hierarchy logic: this migration reuses is_customer_member,
-- is_customer_admin, is_customer_user_visible (from
-- 20260906120000_lead_hierarchy_and_optional_fields.sql), the leads
-- SELECT policy's own predicate, and set_updated_at() exactly as they
-- already exist.
--
-- Design notes:
--   * RELATIONSHIP: tasks.lead_id is required (not null) — there is no
--     standalone-task path anywhere in this schema. tasks.customer_id is
--     also stored directly (not derived via a join every time) so every
--     other same-customer-safe composite FK this app already uses
--     (customer_users.manager_id, leads.owner_id, leads.stage_id) can be
--     mirrored here for both lead_id and assigned_to — see below.
--   * SAME-CUSTOMER SAFETY: tasks.lead_id and tasks.assigned_to are each
--     backed by a composite FK against (customer_id, id) on their target
--     table, the exact pattern already used for leads.owner_id ->
--     customer_users and leads.stage_id -> customer_lead_stages. This is
--     what makes "Task.customer_id = Customer A, Task.lead_id = a
--     Customer B lead" a constraint violation, not just an application
--     convention. public.leads has never needed a unique(customer_id, id)
--     constraint before now (nothing referenced it compositely) — this
--     migration adds it, purely additive, alongside the existing primary
--     key. customer_users already has one (customer_users_customer_id_key,
--     20260904140000).
--   * ASSIGNMENT: assigned_to is required (every task has an owner, even
--     if that's the creator themselves) and uses ON DELETE RESTRICT
--     (matching customer_users.role_id's own restrict pattern) rather
--     than SET NULL — a NOT NULL column can't be nulled by a delete
--     anyway, and customer_users rows are never hard-deleted in this app
--     (deactivated via status = 'Inactive' only), so this is a purely
--     theoretical backstop that stays consistent rather than declaring an
--     ON DELETE behavior that would itself violate NOT NULL if it ever
--     fired.
--   * VISIBILITY = REUSE, NOT A NEW HIERARCHY: is_customer_user_visible()
--     already implements exactly what Section 8 of the spec describes —
--     ADMIN sees everyone in the customer, everyone else sees themselves
--     plus their recursive manager_id descendants — because it looks at
--     the CALLER's own role/position, not the target's. Applying it to
--     tasks.assigned_to directly (no new helper, no role-name branching
--     here) means: ADMIN sees every task, MANAGER/SENIOR_SALES_REP see
--     their own branch's tasks, and a SALES_REP (a leaf in the reporting
--     tree, no descendants) ends up seeing only tasks assigned to
--     themselves — as an emergent property of the existing recursive
--     definition, not a separate "if role = SALES_REP" special case. The
--     leads policy's "hierarchy-aware lead visibility" needs an extra
--     `owner_id is not null` branch because leads.owner_id is nullable
--     (an unassigned lead); tasks.assigned_to is NOT NULL, so that branch
--     isn't needed here — is_customer_user_visible(assigned_to) alone is
--     the complete SELECT/UPDATE predicate.
--   * INSERT additionally requires the caller to currently be able to see
--     the target Lead — the exact same boolean expression the leads
--     SELECT policy itself uses (is_customer_admin OR the lead's own
--     owner_id is visible to the caller), restated here as an EXISTS
--     check against public.leads rather than a new shared helper
--     function, per "reuse the existing lead visibility logic, don't
--     duplicate it as a new primitive." This is what stops a caller from
--     attaching a task to a lead they can't even see.
--   * IDENTITY PROTECTION: a BEFORE UPDATE trigger
--     (protect_task_identity_columns) rejects any change to customer_id
--     or lead_id once a task exists — the same "lock down columns that
--     define what a row fundamentally IS" pattern as
--     protect_lead_owner_id_change. Reassigning (assigned_to) and
--     re-prioritizing/rescheduling/completing are all still ordinary
--     updates, gated by the UPDATE policy below.
--   * COMPLETION, NOT DELETION: there is no DELETE policy or grant at
--     all — the same "deactivate/complete, never hard-delete" pattern
--     already used for customer_lead_stages and customer_catalog_items.
--     A completed task is just status = 'Completed', a normal UPDATE
--     through the one UPDATE policy below; task history is never lost.
--   * PRIORITY defaults to 'Medium' as a real column DEFAULT (not just a
--     frontend default) — the spec is explicit that the database must
--     stay correct even if the frontend is bypassed. STATUS defaults to
--     'Pending' the same way.
--   * due_date is a plain `date`, not `timestamptz` — a due date is a
--     calendar day, not a point in time, so there is no timezone
--     conversion to get right or wrong (the spec's own "do not introduce
--     unnecessary timezone complexity").
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

-- ---------------------------------------------------------------------
-- leads gains the composite-unique constraint tasks.lead_id needs to
-- reference it same-customer-safely — purely additive, nothing about
-- the leads table's existing behavior changes.
-- ---------------------------------------------------------------------

alter table public.leads
  add constraint leads_customer_id_key unique (customer_id, id);

-- ---------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  lead_id uuid not null,
  subject text not null,
  description text,
  priority text not null default 'Medium' check (priority in ('Low', 'Medium', 'High')),
  due_date date not null,
  assigned_to uuid not null,
  type text not null default 'Other' check (type in ('Call', 'Meeting', 'Email', 'Other')),
  status text not null default 'Pending' check (status in ('Pending', 'Completed')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_subject_not_blank check (btrim(subject) <> ''),
  constraint tasks_lead_same_customer_fkey
    foreign key (customer_id, lead_id)
    references public.leads (customer_id, id)
    on delete cascade,
  constraint tasks_assigned_to_same_customer_fkey
    foreign key (customer_id, assigned_to)
    references public.customer_users (customer_id, id)
    on delete restrict
);

create index tasks_customer_id_idx on public.tasks (customer_id);
create index tasks_lead_id_idx on public.tasks (lead_id);
create index tasks_assigned_to_idx on public.tasks (assigned_to);
create index tasks_due_date_idx on public.tasks (due_date);
create index tasks_status_idx on public.tasks (status);

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Identity-column protection (see design notes above)
-- ---------------------------------------------------------------------

create or replace function public.protect_task_identity_columns()
returns trigger
language plpgsql
as $$
begin
  if new.customer_id is distinct from old.customer_id then
    raise exception 'A task''s customer cannot be changed.';
  end if;
  if new.lead_id is distinct from old.lead_id then
    raise exception 'A task''s lead cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger tasks_protect_identity_columns
  before update on public.tasks
  for each row
  execute function public.protect_task_identity_columns();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.tasks enable row level security;

-- SELECT / UPDATE: is_customer_user_visible(assigned_to) alone is the
-- complete predicate — see design notes above for why no extra
-- is_customer_admin()/null-guard clause is needed here (unlike leads).
create policy "hierarchy-aware task visibility"
  on public.tasks for select
  to authenticated
  using (public.is_customer_user_visible(assigned_to));

-- INSERT: any active member of the customer may create a task (every
-- role can, per spec), but only for a Lead they can currently see, and
-- only assigned to someone within their own visible hierarchy —
-- ADMIN -> anyone in the customer, MANAGER/SENIOR_SALES_REP -> self +
-- descendants, SALES_REP -> self only (falls out of
-- is_customer_user_visible's own recursive definition; no separate
-- SALES_REP-specific rule exists or is needed).
create policy "members create tasks for leads and assignees they can see"
  on public.tasks for insert
  to authenticated
  with check (
    public.is_customer_member(customer_id)
    and public.is_customer_user_visible(assigned_to)
    and exists (
      select 1 from public.leads l
      where l.id = tasks.lead_id
        and l.customer_id = tasks.customer_id
        and (
          public.is_customer_admin(l.customer_id)
          or (l.owner_id is not null and public.is_customer_user_visible(l.owner_id))
        )
    )
  );

-- UPDATE: same visibility predicate on both the existing row (USING)
-- and the resulting row (WITH CHECK) — a caller can only update a task
-- they can currently see, and can't use an update to reassign it to
-- someone outside their own visible hierarchy. customer_id/lead_id
-- themselves are separately locked by the trigger above regardless of
-- what this policy would otherwise allow.
create policy "visible-hierarchy members can update a task"
  on public.tasks for update
  to authenticated
  using (public.is_customer_user_visible(assigned_to))
  with check (public.is_customer_user_visible(assigned_to));

-- No DELETE policy or grant at all — completed tasks stay in the
-- database as history, exactly like customer_lead_stages and
-- customer_catalog_items never hard-delete their rows either.
revoke all on public.tasks from anon, authenticated;
grant select, insert, update on public.tasks to authenticated;

commit;
