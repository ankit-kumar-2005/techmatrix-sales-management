-- ---------------------------------------------------------------------
-- THE INVITATION FEATURE — complete database foundation.
--
-- Consolidates 20260914120000 (schema/RLS), 20260914130000 (acceptance),
-- 20260914140000 (pending lookup) and 20260914150000 (acceptance-page
-- context) into one migration. Run only after
-- 20260914160000_cleanup_old_invitation_migrations.sql.
--
-- REUSED, NEVER RECREATED — shared objects this migration depends on and
-- deliberately does not define:
--   public.set_updated_at()          (20260904140000) — updated_at trigger
--   public.is_customer_admin(uuid)   (20260904140000) — RLS authorization
--   public.customers / customer_users / roles / auth.users
--
-- THE INVARIANT EVERYTHING BELOW EXISTS TO PROTECT:
--   admin's customer_id -> invitation.customer_id -> customer_users.customer_id
--   auth.uid()                                    -> customer_users.user_id
-- The invited person never chooses their tenant, role or manager: those
-- are read from the invitation row inside a SECURITY DEFINER function,
-- never accepted as parameters. The ONLY thing a caller supplies at
-- acceptance is which invitation they are accepting.
--
-- CHANGE FROM THE FOUR ORIGINALS: exactly one, called out so this is not
-- mistaken for a silent rewrite —
-- protect_customer_user_invitation_identity_columns() now pins
-- `set search_path = public`. It was the only function in this schema
-- without it. It is not SECURITY DEFINER, so it never had the classic
-- privilege-escalation exposure, but a trigger function whose name
-- resolution depends on the caller's search_path is still a hardening
-- gap and an inconsistency with the other twelve. No behaviour changes.
--
-- Everything else is behaviour-identical to the originals.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

-- =====================================================================
-- 1. TABLE + CONSTRAINTS
-- =====================================================================

create table public.customer_user_invitations (
  id uuid primary key default gen_random_uuid(),

  -- The tenant boundary. Every policy, index and uniqueness rule below
  -- is anchored on this column, and it is immutable after creation.
  customer_id uuid not null references public.customers (id) on delete cascade,

  -- Stored exactly as the admin typed it; compared case/whitespace-
  -- insensitively everywhere (see the unique index below). Format
  -- validation stays in the application's Zod schema — the database
  -- enforces what only the database can (uniqueness, tenant scope).
  email text not null,
  full_name text not null,

  -- The role the invited person receives on acceptance. roles stays the
  -- single source of truth; no role name is ever copied here. RESTRICT
  -- because an invitation is a live reference to a role.
  role_id uuid not null references public.roles (id) on delete restrict,

  -- Same-customer safety comes from the composite FK below; ACTIVE-ness
  -- from the validation trigger (an FK cannot express "and its status is
  -- 'Active'").
  manager_id uuid,

  -- NOT NULL, so ON DELETE SET NULL is impossible; RESTRICT matches
  -- customers.created_by and keeps the audit trail intact.
  invited_by uuid not null references auth.users (id) on delete restrict,

  -- Invitation lifecycle, deliberately UPPERCASE and deliberately
  -- SEPARATE from customer_users.status (Active/Inactive). The two are
  -- never merged: a PENDING invitation has no membership at all.
  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED')),

  -- invited_at is the ORIGINAL send; last_sent_at moves on every resend.
  -- Keeping both is what lets the backend throttle resends without
  -- losing when the invitation actually started.
  invited_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  accepted_at timestamptz,

  -- One hour, matching Supabase's own default email-link validity. A
  -- resend refreshes this. No cron flips elapsed rows to EXPIRED — every
  -- reader checks the clock alongside the stored status instead.
  expires_at timestamptz not null default (now() + interval '1 hour'),

  -- Links an accepted invitation to the membership it produced, so the
  -- Invitation History list can read live Membership Status through a
  -- plain RLS-scoped query instead of joining auth.users (which
  -- `authenticated` has no privilege on). Stores a RELATIONSHIP, never a
  -- copy of customer_users.status, so the two can never drift.
  accepted_customer_user_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_user_invitations_email_not_blank check (btrim(email) <> ''),
  constraint customer_user_invitations_full_name_not_blank check (btrim(full_name) <> ''),

  -- An invitation that expires before it was sent is nonsense. Holds on
  -- resend too (expires_at moves forward, invited_at never does).
  constraint customer_user_invitations_expiry_after_invite check (expires_at > invited_at),

  -- accepted_at exists exactly when the invitation is ACCEPTED. Catches
  -- "accepted with no timestamp" and "cancelled/expired but carrying an
  -- acceptance time" in one constraint. Deliberately NOT extended to
  -- accepted_customer_user_id, which can legitimately return to NULL if
  -- that membership row is deleted (see its FK below).
  constraint customer_user_invitations_accepted_at_matches_status
    check ((status = 'ACCEPTED') = (accepted_at is not null)),

  -- COMPOSITE foreign keys, both including customer_id: this is what
  -- makes it structurally impossible for an invitation to reference a
  -- manager — or an accepted membership — belonging to another tenant.
  constraint customer_user_invitations_manager_same_customer_fkey
    foreign key (customer_id, manager_id)
    references public.customer_users (customer_id, id)
    on delete set null (manager_id),

  constraint customer_user_invitations_accepted_membership_fkey
    foreign key (customer_id, accepted_customer_user_id)
    references public.customer_users (customer_id, id)
    on delete set null (accepted_customer_user_id)
);

-- =====================================================================
-- 2. INDEXES
--
-- Nothing speculative; each is justified by a query this feature runs.
-- No index for the search box: it is an ILIKE '%term%' (leading
-- wildcard), which no B-tree can serve — the customer_id-leading indexes
-- are what keep that scan bounded to one tenant.
-- =====================================================================

-- THE core rule: at most one PENDING invitation per customer per
-- normalized email. A second invitation is allowed once the first is
-- ACCEPTED/EXPIRED/CANCELLED, which a plain unique(customer_id, email)
-- could never express. (The predicate cannot also test expires_at >
-- now(): partial index predicates must be IMMUTABLE. An elapsed-but-
-- still-PENDING row therefore still blocks a duplicate, which is the
-- desired behaviour — it pushes the application into the resend path
-- rather than accumulating rows.)
create unique index customer_user_invitations_unique_pending_email_per_customer
  on public.customer_user_invitations (customer_id, lower(btrim(email)))
  where status = 'PENDING';

-- The Invitation History list: tenant-scoped, newest first, paginated.
-- A plain (not DESC) B-tree serves "ORDER BY invited_at DESC" because
-- customer_id is an equality predicate — PostgreSQL scans it backwards.
-- Its leading column also covers plain customer_id lookups and the
-- customers ON DELETE CASCADE, so no separate customer_id index exists.
create index customer_user_invitations_customer_invited_at_idx
  on public.customer_user_invitations (customer_id, invited_at);

-- These four support the referential actions above, not reads: without
-- them, deleting a role (RESTRICT), a customer_users row (SET NULL on
-- two columns) or an auth user (RESTRICT) sequentially scans this table.
create index customer_user_invitations_role_id_idx
  on public.customer_user_invitations (role_id);
create index customer_user_invitations_manager_id_idx
  on public.customer_user_invitations (manager_id);
create index customer_user_invitations_invited_by_idx
  on public.customer_user_invitations (invited_by);
create index customer_user_invitations_accepted_membership_idx
  on public.customer_user_invitations (accepted_customer_user_id);

-- =====================================================================
-- 3. TRIGGER FUNCTIONS + TRIGGERS
-- =====================================================================

-- Identity protection — same pattern as protect_task_identity_columns /
-- protect_contact_identity_columns. customer_id is the tenant boundary
-- and must never move. email is the invitation's identity: a mistyped
-- address is CANCELLED and re-invited, never silently rewritten under an
-- existing audit trail.
create or replace function public.protect_customer_user_invitation_identity_columns()
returns trigger
language plpgsql
set search_path = public
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

-- Validation a foreign key cannot express.
--
-- SECURITY DEFINER for exactly one reason: the already-a-member check
-- reads auth.users (to resolve a membership's email), which
-- `authenticated` has no privilege on. EXECUTE is revoked from everyone
-- below — it is reachable only as this table's own trigger, never as a
-- callable enumeration surface.
--
-- Each check runs on INSERT, and on UPDATE only when the value it guards
-- actually changed. That matters concretely: a resend (last_sent_at/
-- expires_at only) must not fail because an unrelated manager was
-- deactivated meanwhile, and acceptance sets status = 'ACCEPTED' at the
-- exact moment a membership for that email DOES exist — re-running the
-- already-a-member check there would make accepting impossible.
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

  -- Role must still be offered.
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
  -- customer — active or inactive. Scoped strictly to new.customer_id:
  -- this tells an admin only about their own organization and leaks
  -- nothing about any other tenant's users, which is why it is safe
  -- inside a SECURITY DEFINER function that can see all of auth.users.
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

-- Matches the original exactly. `authenticated`/`anon` only ever held
-- EXECUTE here by way of PUBLIC, so revoking PUBLIC removes it for them
-- too; naming them as well would change nothing. The signature IS given
-- explicitly (the original omitted it), which is precision, not a
-- behaviour change. Trigger execution is unaffected either way:
-- PostgreSQL checks EXECUTE on a trigger function at CREATE TRIGGER
-- time, not on every fire.
revoke all on function public.validate_customer_user_invitation() from public;

-- Reuses the existing shared trigger function (20260904140000) — no
-- second timestamp function is created.
create trigger customer_user_invitations_set_updated_at
  before update on public.customer_user_invitations
  for each row execute function public.set_updated_at();

create trigger customer_user_invitations_protect_identity_columns
  before update on public.customer_user_invitations
  for each row
  execute function public.protect_customer_user_invitation_identity_columns();

create trigger customer_user_invitations_validate
  before insert or update on public.customer_user_invitations
  for each row
  execute function public.validate_customer_user_invitation();

-- =====================================================================
-- 4. ROW LEVEL SECURITY — ADMIN of the row's own customer, nobody else.
--
-- is_customer_admin(customer_id) is reused verbatim: it resolves the
-- caller from auth.uid() server-side, so a customer_id sent by the
-- browser is never trusted — a request naming another tenant simply
-- matches no policy. MANAGER, SENIOR_SALES_REP and SALES_REP get no
-- invitation access at all, by omission rather than explicit deny.
--
-- An invitee accepting is not an admin — is not a member at all — so
-- they cannot and must not satisfy these policies. Acceptance goes
-- through accept_customer_user_invitation() instead. Do NOT weaken these
-- policies to make acceptance work.
-- =====================================================================

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

-- Explicit grants (defense in depth alongside RLS — PostgREST needs both
-- a GRANT and a matching policy; neither alone is enough). anon gets
-- nothing. NO DELETE grant and NO DELETE policy: invitations are
-- retained as history.
revoke all on public.customer_user_invitations from anon, authenticated;
grant select, insert, update on public.customer_user_invitations to authenticated;

-- =====================================================================
-- 5. ACCEPTANCE — the one controlled door from PENDING to a membership.
--
-- SECURITY DEFINER is the only way this can work:
--   * customer_users has NO INSERT policy and NO INSERT grant for
--     `authenticated`; an invitee has no privilege to create their own
--     membership.
--   * this table's UPDATE policy is ADMIN-only, so an invitee cannot
--     mark their own invitation ACCEPTED either.
--   * resolving the caller's verified email requires reading auth.users,
--     which `authenticated` has no privilege on.
--
-- THE ONLY PARAMETER IS THE INVITATION ID. customer_id, role_id,
-- manager_id and full_name are all read from the invitation row; a
-- caller cannot choose their own tenant, role, manager or name by
-- crafting the request. This is the single most important property here.
--
-- WHY NO INVITATION TOKEN: the security boundary is Supabase Auth's own
-- email verification. By the time this runs, auth.uid() resolves to an
-- address Supabase has already proven the caller controls; this function
-- requires that address to match the invitation's. The invitation id is
-- an identifier, not a secret.
--
-- ATOMICITY: a plpgsql body runs inside the caller's transaction, so the
-- membership INSERT and the invitation UPDATE either both commit or both
-- roll back. SELECT ... FOR UPDATE locks the invitation first, so two
-- concurrent accepts serialize: the second sees status = 'ACCEPTED' and
-- takes the idempotent-retry path rather than inserting a second
-- membership.
-- =====================================================================

create or replace function public.accept_customer_user_invitation(p_invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_caller_email text;
  v_invitation public.customer_user_invitations;
  v_membership_id uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select lower(btrim(u.email)) into v_caller_email
  from auth.users u
  where u.id = v_user_id;

  if v_caller_email is null or v_caller_email = '' then
    raise exception 'Your account does not have a usable email address.';
  end if;

  select * into v_invitation
  from public.customer_user_invitations
  where id = p_invitation_id
  for update;

  -- "Not found" and "found but addressed to somebody else" deliberately
  -- share one message: distinguishing them would turn this function into
  -- an oracle confirming that a given invitation id exists (and for
  -- whom) to anyone who can guess an id.
  if not found or lower(btrim(v_invitation.email)) <> v_caller_email then
    raise exception 'This invitation is not valid for your account.';
  end if;

  -- Idempotent retry, but ONLY for the same person: a refreshed or
  -- double-clicked acceptance returns the membership already created
  -- instead of failing. Anyone else hitting an already-accepted
  -- invitation still gets a hard error.
  if v_invitation.status = 'ACCEPTED' then
    if v_invitation.accepted_customer_user_id is not null
       and exists (
         select 1 from public.customer_users cu
         where cu.id = v_invitation.accepted_customer_user_id
           and cu.user_id = v_user_id
       ) then
      return v_invitation.accepted_customer_user_id;
    end if;
    raise exception 'This invitation has already been accepted.';
  end if;

  if v_invitation.status = 'CANCELLED' then
    raise exception 'This invitation has been cancelled.';
  end if;

  -- Both the stored status AND the clock: an invitation whose expires_at
  -- has passed is expired whether or not anything wrote 'EXPIRED' yet.
  if v_invitation.status = 'EXPIRED' or v_invitation.expires_at <= now() then
    raise exception 'This invitation has expired.';
  end if;

  if v_invitation.status <> 'PENDING' then
    raise exception 'This invitation is no longer valid.';
  end if;

  if not exists (
    select 1 from public.roles r
    where r.id = v_invitation.role_id
      and r.status = 'Active'
  ) then
    raise exception 'The role on this invitation is no longer available.';
  end if;

  -- manager_id may legitimately be NULL (no manager, or the referenced
  -- membership was deleted and the FK nulled it) — only a non-null
  -- manager has to still be an active member of the same customer.
  if v_invitation.manager_id is not null then
    if not exists (
      select 1 from public.customer_users cu
      where cu.id = v_invitation.manager_id
        and cu.customer_id = v_invitation.customer_id
        and cu.status = 'Active'
    ) then
      raise exception 'The manager on this invitation is no longer active.';
    end if;
  end if;

  -- The one-active-membership-per-user rule is enforced by a unique
  -- index regardless; checking here turns a raw 23505 into a stable,
  -- translatable message. The second check covers an INACTIVE membership
  -- in this same customer, which that index would not catch.
  if exists (
    select 1 from public.customer_users cu
    where cu.user_id = v_user_id
      and cu.status = 'Active'
  ) then
    raise exception 'This account already belongs to an organization.';
  end if;

  if exists (
    select 1 from public.customer_users cu
    where cu.user_id = v_user_id
      and cu.customer_id = v_invitation.customer_id
  ) then
    raise exception 'This account already belongs to an organization.';
  end if;

  -- EVERY value here comes from the invitation row or from auth.uid().
  -- Nothing comes from the caller. No customer is created: the invited
  -- person joins the customer that already exists.
  insert into public.customer_users (customer_id, user_id, role_id, manager_id, name, status)
  values (
    v_invitation.customer_id,
    v_user_id,
    v_invitation.role_id,
    v_invitation.manager_id,
    v_invitation.full_name,
    'Active'
  )
  returning id into v_membership_id;

  -- Passes this table's own triggers unchanged: customer_id and email
  -- are untouched (identity protection), the validation trigger's
  -- manager/role checks only fire when those columns change, and its
  -- already-a-member check is INSERT-only. status and accepted_at move
  -- together, satisfying the accepted_at_matches_status constraint.
  update public.customer_user_invitations
     set status = 'ACCEPTED',
         accepted_at = now(),
         accepted_customer_user_id = v_membership_id
   where id = v_invitation.id;

  return v_membership_id;
end;
$$;

revoke all on function public.accept_customer_user_invitation(uuid) from public, anon;
grant execute on function public.accept_customer_user_invitation(uuid) to authenticated;

-- =====================================================================
-- 6. PENDING LOOKUP — "do I myself have an invitation waiting?"
--
-- Used by /set-password to reroute an invited user out of the normal
-- customer-creation flow. Without it, an invited person who ignores the
-- invitation email and signs up normally would reach
-- create_customer_with_admin() and become the ADMIN of a brand new
-- customer, after which the one-active-membership rule makes their real
-- invitation permanently unacceptable.
--
-- Takes NO parameters, so a caller can only ever ask about themselves.
-- Returns one uuid and nothing else.
-- =====================================================================

create or replace function public.get_pending_invitation_for_current_user()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select i.id
  from public.customer_user_invitations i
  join auth.users u on u.id = auth.uid()
  where i.status = 'PENDING'
    and i.expires_at > now()
    and lower(btrim(i.email)) = lower(btrim(u.email))
  order by i.invited_at desc
  limit 1;
$$;

revoke all on function public.get_pending_invitation_for_current_user() from public, anon;
grant execute on function public.get_pending_invitation_for_current_user() to authenticated;

-- =====================================================================
-- 7. ACCEPTANCE-PAGE CONTEXT — "is the signed-in account the invited
--    one, and if so, what is this invitation for?"
--
-- WHY THIS IS NOT REDUNDANT with section 6: that one answers "which
-- invitation is waiting for ME" (no parameter, used before the user has
-- a link in hand). This one answers "does THIS invitation belong to me"
-- for a specific id the user arrived on. Neither can substitute for the
-- other, and neither stores anything — there is no context table.
--
-- WHY IT IS REQUIRED AT ALL: RLS above is ADMIN-only, so the acceptance
-- page could not read the invitation and therefore could not compare the
-- invited address against the session's. It rendered an enabled Accept
-- button for ANY session — including the admin who sent the invitation,
-- still signed in in the same browser. Acceptance always refused that
-- correctly, so nothing unsafe happened; the failure was that the
-- mismatch could only be discovered by pressing a button guaranteed to
-- fail.
--
-- GRADUATED DISCLOSURE:
--   * anon cannot execute it; auth.uid() null returns zero rows.
--   * a signed-in caller whose email does NOT match learns only
--     matches_current_user = false plus a MASKED hint (r***l@acme.com).
--     No company, role, manager or status. That is strictly less than
--     they already learn by pressing Accept.
--   * only a caller whose VERIFIED email matches gets company, role,
--     manager and status — and they are the invited person reading their
--     own invitation.
--   * `stable`, read-only, returns no ids of any kind, grants nothing.
-- =====================================================================

create or replace function public.get_invitation_context(p_invitation_id uuid)
returns table (
  matches_current_user boolean,
  invited_email_hint text,
  company_name text,
  role_name text,
  manager_name text,
  effective_status text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_user_id uuid := auth.uid();
  v_caller_email text;
  v_invitation public.customer_user_invitations;
  v_matches boolean;
  v_local text;
  v_domain text;
  v_hint text;
  v_company text := null;
  v_role text := null;
  v_manager text := null;
  v_status text := null;
begin
  -- Unauthenticated callers learn nothing. Zero rows, not an error: the
  -- application treats "no context" as "behave exactly as before".
  if v_user_id is null then
    return;
  end if;

  select lower(btrim(u.email)) into v_caller_email
  from auth.users u
  where u.id = v_user_id;

  select * into v_invitation
  from public.customer_user_invitations
  where id = p_invitation_id;

  if not found then
    return;
  end if;

  v_matches := v_caller_email is not null
               and lower(btrim(v_invitation.email)) = v_caller_email;

  -- Masked either way: enough for a human to recognise their own
  -- address, never enough to harvest somebody else's.
  v_local := split_part(btrim(v_invitation.email), '@', 1);
  v_domain := split_part(btrim(v_invitation.email), '@', 2);
  if length(v_local) <= 2 then
    v_hint := left(v_local, 1) || '***@' || v_domain;
  else
    v_hint := left(v_local, 1) || '***' || right(v_local, 1) || '@' || v_domain;
  end if;

  if v_matches then
    select c.company_name into v_company
    from public.customers c
    where c.id = v_invitation.customer_id;

    select r.name into v_role
    from public.roles r
    where r.id = v_invitation.role_id;

    if v_invitation.manager_id is not null then
      select cu.name into v_manager
      from public.customer_users cu
      where cu.id = v_invitation.manager_id;
    end if;

    -- Same "status plus the clock" rule acceptance applies, because no
    -- sweep job ever writes 'EXPIRED'.
    v_status := case
      when v_invitation.status = 'PENDING' and v_invitation.expires_at <= now() then 'EXPIRED'
      else v_invitation.status
    end;
  end if;

  return query select v_matches, v_hint, v_company, v_role, v_manager, v_status;
end;
$$;

revoke all on function public.get_invitation_context(uuid) from public, anon;
grant execute on function public.get_invitation_context(uuid) to authenticated;

commit;
