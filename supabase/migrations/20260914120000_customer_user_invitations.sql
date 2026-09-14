-- User invitations — the DATABASE FOUNDATION for the Add User feature.
-- Schema, constraints, RLS and grants only: no email sending, no
-- acceptance flow, no UI, no scheduled jobs (all explicitly later
-- phases). Nothing outside this one new table is created or altered by
-- this migration.
--
-- Design notes:
--   * A SEPARATE TABLE, NOT FLAGS ON customer_users: customer_users
--     represents an ACTUAL authenticated organization membership —
--     user_id NOT NULL references auth.users, one active membership per
--     user (customer_users_one_active_membership_per_user,
--     20260906120000). An invitation exists BEFORE any auth user does,
--     so it cannot live there without either nulling user_id or
--     inventing a fake auth.users row. Both were rejected: this table
--     owns the invitation lifecycle, customer_users keeps owning the
--     membership lifecycle, and nothing about customer_users changes
--     here.
--   * INVITATION STATUS IS NOT MEMBERSHIP STATUS. This table's status is
--     PENDING/ACCEPTED/EXPIRED/CANCELLED; customer_users.status stays
--     'Active'/'Inactive' and is never copied here. An admin
--     deactivating a user later leaves their invitation ACCEPTED — the
--     two answer different questions and are read from their own tables.
--   * STATUS VALUE CASING: every other status column in this project is
--     Title case ('Active'/'Inactive', tasks' 'Pending'/'Completed').
--     These four values are deliberately UPPERCASE, per the approved
--     spec for this feature, precisely so an invitation status can never
--     be confused with (or accidentally compared against) a membership
--     status. This is the one place that convention is broken, on
--     purpose; see the report accompanying this migration.
--   * EMAIL IS STORED AS TYPED, COMPARED NORMALIZED: the row keeps
--     whatever the admin entered (so the invitation history can show
--     "John@Example.com" back to them), while every uniqueness/lookup
--     comparison goes through lower(btrim(email)) — the same functional-
--     index technique customer_lead_stages_unique_name_per_customer
--     (20260907120000) already uses for case/whitespace-insensitive
--     names. No citext, no extra extension, no second normalized column.
--   * MANAGER AND MEMBERSHIP LINKS ARE TENANT-SAFE BY CONSTRUCTION: both
--     use the composite (customer_id, <col>) -> customer_users
--     (customer_id, id) foreign key this project already uses for
--     customer_users.manager_id, leads.owner_id, tasks.assigned_to and
--     contacts.owner_id, with PostgreSQL 15+'s ON DELETE SET NULL
--     (<column>) so only that column is nulled, never customer_id.
--     Cross-tenant assignment is a constraint violation, not a
--     convention.
--   * NO DELETE POLICY OR GRANT: invitations are history. Cancelling is
--     status = 'CANCELLED', the same "deactivate, never hard-delete"
--     posture tasks, contacts and customer_catalog_items already take.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

-- ---------------------------------------------------------------------
-- customer_user_invitations
-- ---------------------------------------------------------------------

create table public.customer_user_invitations (
  id uuid primary key default gen_random_uuid(),

  -- The tenant boundary. Every policy, index and uniqueness rule below
  -- is anchored on this column, and it is immutable after creation (see
  -- protect_customer_user_invitation_identity_columns).
  customer_id uuid not null references public.customers (id) on delete cascade,

  -- Stored exactly as the admin typed it; compared case/whitespace-
  -- insensitively everywhere (see the unique index below). Format
  -- validation stays in the application's Zod schema, matching how every
  -- other email in this project is validated — the database enforces
  -- what only the database can (uniqueness, tenant scope), not shape.
  email text not null,
  full_name text not null,

  -- The role the invited person will receive when they accept. The roles
  -- table stays the single source of truth — no role names are copied or
  -- hardcoded here. RESTRICT because an invitation is a live reference to
  -- a role; roles are reference data managed only by migrations.
  role_id uuid not null references public.roles (id) on delete restrict,

  -- The manager the invited person will report to, if any. Same-customer
  -- safety is enforced by the composite FK below, ACTIVE-ness by the
  -- validation trigger (an FK cannot express "and its status is
  -- 'Active'").
  manager_id uuid,

  -- Which authenticated user sent this. NOT NULL, so ON DELETE SET NULL
  -- is impossible; RESTRICT matches customers.created_by — the project's
  -- only other NOT NULL auth.users reference — and keeps the audit trail
  -- intact rather than silently orphaning it.
  invited_by uuid not null references auth.users (id) on delete restrict,

  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED')),

  -- invited_at is the ORIGINAL send; last_sent_at moves on every resend.
  -- Keeping both is what lets the backend throttle resends (see §19 of
  -- the spec) without losing when the invitation actually started.
  invited_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  accepted_at timestamptz,

  -- One hour, matching Supabase's own default email-link validity. A
  -- resend refreshes this; the application decides when to flip an
  -- elapsed PENDING row to EXPIRED (no cron is created here).
  expires_at timestamptz not null default (now() + interval '1 hour'),

  -- THE ONE FIELD BEYOND THE APPROVED LIST — see the accompanying
  -- report's justification. Set by the future acceptance flow to the
  -- customer_users row that was created for this invitation, so the
  -- Invitation History list can read Membership Status through a plain
  -- PostgREST embed on this FK. Without it, the only way to tell whether
  -- an invited email became a member is to join auth.users by email, and
  -- `authenticated` has no privilege on auth.users at all — which would
  -- force the whole list (with its search and pagination) into a
  -- SECURITY DEFINER RPC instead of the plain RLS-scoped query Contacts
  -- and Tasks use. This stores a RELATIONSHIP, never a copy of
  -- customer_users.status: the status itself is still read live from
  -- customer_users through this link, so the two can never drift.
  accepted_customer_user_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_user_invitations_email_not_blank check (btrim(email) <> ''),
  constraint customer_user_invitations_full_name_not_blank check (btrim(full_name) <> ''),

  -- An invitation that expires before it was sent is nonsense. Holds on
  -- resend too (expires_at moves forward, invited_at never does).
  constraint customer_user_invitations_expiry_after_invite check (expires_at > invited_at),

  -- accepted_at exists exactly when the invitation is ACCEPTED. Catches
  -- both broken states in one constraint: "accepted with no timestamp"
  -- and "cancelled/expired but carrying an acceptance time". Deliberately
  -- NOT extended to accepted_customer_user_id, which can legitimately go
  -- back to NULL if that membership row is ever deleted (see its FK's
  -- ON DELETE SET NULL below).
  constraint customer_user_invitations_accepted_at_matches_status
    check ((status = 'ACCEPTED') = (accepted_at is not null)),

  constraint customer_user_invitations_manager_same_customer_fkey
    foreign key (customer_id, manager_id)
    references public.customer_users (customer_id, id)
    on delete set null (manager_id),

  constraint customer_user_invitations_accepted_membership_fkey
    foreign key (customer_id, accepted_customer_user_id)
    references public.customer_users (customer_id, id)
    on delete set null (accepted_customer_user_id)
);

-- ---------------------------------------------------------------------
-- Indexes. Every one of these is justified by a query this feature is
-- specified to run; nothing speculative. No index is created for the
-- search box: it is an ILIKE '%term%' (leading wildcard), which no
-- B-tree can serve — exactly as in Contacts and Tasks today. The
-- customer_id-leading indexes are what keep that scan bounded to one
-- tenant.
-- ---------------------------------------------------------------------

-- THE core requirement: at most one PENDING invitation per customer per
-- normalized email. "john@example.com", "John@Example.com" and
-- "  john@example.com " collide; a second invitation is still allowed
-- once the first is ACCEPTED/EXPIRED/CANCELLED, which a plain
-- unique(customer_id, email) could never express. Also the index the
-- resend path's "find the existing PENDING invitation" lookup uses.
-- (The predicate cannot also test expires_at > now(): partial index
-- predicates must be IMMUTABLE, and now() is not. An elapsed-but-still-
-- PENDING row therefore still blocks a duplicate, which is the desired
-- behavior — it pushes the application into the reuse/resend path
-- rather than accumulating rows.)
create unique index customer_user_invitations_unique_pending_email_per_customer
  on public.customer_user_invitations (customer_id, lower(btrim(email)))
  where status = 'PENDING';

-- The Invitation History list: tenant-scoped, newest first, paginated
-- with .range() — the same query shape getContactsPage/getTasksBucketPage
-- already use. A plain (not DESC) B-tree serves "ORDER BY invited_at
-- DESC" here because customer_id is an equality predicate and invited_at
-- is the only ordering column: PostgreSQL simply scans the index
-- backwards. Its leading column also covers plain customer_id lookups
-- and the customers ON DELETE CASCADE, so no separate customer_id index
-- is created (it would be a redundant prefix).
create index customer_user_invitations_customer_invited_at_idx
  on public.customer_user_invitations (customer_id, invited_at);

-- These three support the referential actions above, not reads: without
-- them, deleting a role (RESTRICT), a customer_users row (SET NULL on
-- two columns) or an auth user (RESTRICT) sequentially scans this table.
-- Same per-foreign-key indexing convention customer_users, leads, tasks
-- and contacts already follow. Cheap here — invitations are a low-write,
-- low-volume table — and role_id/manager_id additionally serve the Role
-- and Manager filters the list view is specified to grow later.
create index customer_user_invitations_role_id_idx
  on public.customer_user_invitations (role_id);
create index customer_user_invitations_manager_id_idx
  on public.customer_user_invitations (manager_id);
create index customer_user_invitations_invited_by_idx
  on public.customer_user_invitations (invited_by);
create index customer_user_invitations_accepted_membership_idx
  on public.customer_user_invitations (accepted_customer_user_id);

-- Reuses the existing shared trigger function (20260904140000) — no
-- second timestamp function is created.
create trigger customer_user_invitations_set_updated_at
  before update on public.customer_user_invitations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Identity protection — same pattern and reasoning as
-- protect_task_identity_columns / protect_contact_identity_columns:
-- lock down the columns that define what a row fundamentally IS.
-- customer_id is the tenant boundary and must never move. email is the
-- invitation's identity: a mistyped address is CANCELLED and re-invited
-- (which the lifecycle and the partial unique index both support), never
-- silently rewritten under an existing audit trail.
-- ---------------------------------------------------------------------

create or replace function public.protect_customer_user_invitation_identity_columns()
returns trigger
language plpgsql
as $$
begin
  if new.customer_id is distinct from old.customer_id then
    raise exception 'An invitation''s customer cannot be changed.';
  end if;
  if new.email is distinct from old.email then
    raise exception 'An invitation''s email address cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger customer_user_invitations_protect_identity_columns
  before update on public.customer_user_invitations
  for each row
  execute function public.protect_customer_user_invitation_identity_columns();

-- ---------------------------------------------------------------------
-- Validation the database can enforce but a foreign key cannot.
--
-- SECURITY DEFINER is required for exactly one reason: the
-- already-a-member check reads auth.users (to resolve a membership's
-- email), which `authenticated` has no privilege on. `set search_path =
-- public` pins name resolution, the function returns nothing but a
-- trigger row, and EXECUTE is revoked from everyone below — it is
-- reachable only as this table's own trigger, never as a callable
-- enumeration surface.
--
-- Each check runs on INSERT, and on UPDATE only when the value it
-- guards actually changed — the same "TG_OP = 'INSERT' or NEW.x IS
-- DISTINCT FROM OLD.x" shape protect_lead_stage_transition
-- (20260907120000) already uses. That matters concretely:
--   * a resend (last_sent_at/expires_at only) must not fail because an
--     unrelated manager was deactivated in the meantime, and
--   * the future acceptance flow sets status = 'ACCEPTED' at the exact
--     moment a membership for that email DOES exist — re-running the
--     already-a-member check there would make accepting an invitation
--     impossible.
--
-- Exception messages are stable, human-readable and matched by the
-- application layer, following the same convention
-- create_customer_with_admin's "User already belongs to a customer"
-- already established. A Server Action must translate them; raw
-- database errors are never shown to users (CLAUDE.md Section K).
-- ---------------------------------------------------------------------

create or replace function public.validate_customer_user_invitation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Manager must be an ACTIVE membership of this same customer. The
  -- composite FK already guarantees "same customer"; this adds the part
  -- a foreign key cannot express.
  if new.manager_id is not null
     and (TG_OP = 'INSERT' or new.manager_id is distinct from old.manager_id) then
    if not exists (
      select 1
      from public.customer_users cu
      where cu.id = new.manager_id
        and cu.customer_id = new.customer_id
        and cu.status = 'Active'
    ) then
      raise exception 'The selected manager must be an active member of this customer.';
    end if;
  end if;

  -- Role must still be offered. roles.status is reference data managed
  -- by migrations, so this is a cheap guard against inviting someone
  -- into a retired role.
  if TG_OP = 'INSERT' or new.role_id is distinct from old.role_id then
    if not exists (
      select 1 from public.roles r
      where r.id = new.role_id
        and r.status = 'Active'
    ) then
      raise exception 'The selected role is not available.';
    end if;
  end if;

  -- The invited email must not already belong to a member of THIS
  -- customer — active or inactive. Re-inviting an inactive colleague is
  -- a reactivation, not an invitation, and would collide with the
  -- one-active-membership-per-user rule at acceptance time anyway.
  -- Scoped strictly to new.customer_id: this tells an admin only about
  -- their own organization and leaks nothing about any other tenant's
  -- users, which is why it is safe to run inside a SECURITY DEFINER
  -- function that can see all of auth.users.
  if TG_OP = 'INSERT' then
    if exists (
      select 1
      from public.customer_users cu
      join auth.users u on u.id = cu.user_id
      where cu.customer_id = new.customer_id
        and lower(btrim(u.email)) = lower(btrim(new.email))
    ) then
      raise exception 'A user with this email address is already a member of this customer.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.validate_customer_user_invitation from public;

create trigger customer_user_invitations_validate
  before insert or update on public.customer_user_invitations
  for each row
  execute function public.validate_customer_user_invitation();

-- ---------------------------------------------------------------------
-- Row Level Security — ADMIN of the row's own customer, and nobody else.
--
-- is_customer_admin(customer_id) (20260904140000) is reused verbatim: it
-- resolves the caller from auth.uid() server-side, so a customer_id sent
-- by the browser is never trusted — a request naming another tenant
-- simply matches no policy. MANAGER, SENIOR_SALES_REP and SALES_REP get
-- no invitation access at all in this phase, by omission rather than by
-- an explicit deny.
--
-- NOTE FOR THE ACCEPTANCE PHASE: an invitee accepting their invitation
-- is not yet an admin — is not yet a member at all — so they cannot and
-- must not satisfy these policies. Acceptance therefore needs its own
-- narrow SECURITY DEFINER function (the same "one controlled door in"
-- shape create_customer_with_admin already uses for signup), which
-- re-validates the invitation and creates the customer_users row
-- itself. Do not weaken these policies to make acceptance work.
-- ---------------------------------------------------------------------

alter table public.customer_user_invitations enable row level security;

create policy "admins can view their customer's invitations"
  on public.customer_user_invitations for select
  to authenticated
  using (public.is_customer_admin(customer_id));

create policy "admins can create invitations for their customer"
  on public.customer_user_invitations for insert
  to authenticated
  with check (public.is_customer_admin(customer_id));

-- Resend (last_sent_at/expires_at), cancel (status) and role/manager
-- corrections. USING and WITH CHECK are the same predicate, so an admin
-- can never move a row out of (or into) another tenant; customer_id and
-- email are separately immutable via the trigger above regardless.
create policy "admins can update their customer's invitations"
  on public.customer_user_invitations for update
  to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

-- ---------------------------------------------------------------------
-- Explicit grants (defense in depth alongside RLS — PostgREST needs both
-- a GRANT and a matching policy; neither alone is enough). anon gets
-- nothing. No DELETE grant and no DELETE policy: invitations are
-- retained as history.
-- ---------------------------------------------------------------------

revoke all on public.customer_user_invitations from anon, authenticated;
grant select, insert, update on public.customer_user_invitations to authenticated;

commit;
