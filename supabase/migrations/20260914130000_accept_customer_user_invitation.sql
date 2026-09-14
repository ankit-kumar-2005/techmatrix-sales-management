-- Invitation acceptance — the one controlled door from a PENDING
-- invitation to a real customer_users membership.
--
-- Adds exactly one function. No table, column, policy, index, trigger or
-- prior migration is touched; 20260914120000's schema is used as-is.
--
-- SECURITY DECISION — why this is SECURITY DEFINER, and why that is the
-- only way this can work:
--   * customer_users has NO INSERT policy and NO INSERT grant for
--     `authenticated` at all (20260904140000's own design note: "the only
--     way to create either is create_customer_with_admin()"). An invitee
--     therefore has no privilege of their own to create their membership.
--   * customer_user_invitations' UPDATE policy is ADMIN-of-that-customer
--     only (20260914120000). An invitee accepting is not an admin — is
--     not a member at all yet — so they cannot mark their own invitation
--     ACCEPTED either. Weakening that policy to let them was rejected:
--     it would hand every authenticated user write access to invitation
--     rows.
--   * resolving the caller's own verified email requires reading
--     auth.users, which `authenticated` has no privilege on.
-- This function runs with the definer's privilege specifically so it CAN
-- do those three things, while remaining the only path that can. The
-- same safety measures create_customer_with_admin documents apply here:
--   * `set search_path = public` pins name resolution, so a caller
--     cannot shadow public.customer_users/roles with objects in another
--     schema.
--   * auth.uid() is re-validated inside and never accepted as a
--     parameter.
--   * the ONLY parameter is the invitation's id. customer_id, role_id,
--     manager_id and full_name are all read from the invitation row
--     itself — a caller cannot choose their own tenant, role, manager or
--     name by crafting the request. This is the single most important
--     property of this function.
--   * every business precondition is re-validated here, not trusted from
--     whatever the application checked first.
--   * only `authenticated` may execute it; anon and public cannot.
--
-- WHY THERE IS NO INVITATION TOKEN: the security boundary is Supabase
-- Auth's own email verification, not a secret this table stores. By the
-- time this runs, the invitee has authenticated, so auth.uid() resolves
-- to an email address Supabase has already proven they control; this
-- function simply requires that address to match the invitation's. The
-- invitation id is an identifier, not a secret — knowing one grants
-- nothing without also being signed in as that exact email. A
-- home-grown token would add a second secret to store, transmit, expire
-- and leak, protecting something Auth already protects.
--
-- ATOMICITY: a plpgsql function body runs inside the caller's
-- transaction, so the membership INSERT and the invitation UPDATE either
-- both commit or both roll back. SELECT ... FOR UPDATE takes a row lock
-- on the invitation first, so two concurrent accepts of the same
-- invitation serialize: the second one sees status = 'ACCEPTED' and
-- takes the idempotent-retry path below rather than inserting a second
-- membership.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

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
  -- an oracle confirming that a given invitation id exists (and for whom)
  -- to anyone who can guess an id. The application shows the same
  -- friendly text either way.
  if not found or lower(btrim(v_invitation.email)) <> v_caller_email then
    raise exception 'This invitation is not valid for your account.';
  end if;

  -- Idempotent retry, but ONLY for the same person: a refreshed or
  -- double-clicked acceptance link returns the membership that was
  -- already created instead of failing, the same "a retried completion
  -- is success, not an error" behavior SetPasswordForm already relies on
  -- for create_customer_with_admin. Anyone else hitting an already-
  -- accepted invitation still gets a hard error.
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

  -- Both the stored status AND the clock are checked: an invitation
  -- whose expires_at has passed is expired whether or not anything has
  -- got around to writing 'EXPIRED' into the row yet (no cron exists —
  -- see 20260914120000).
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

  -- The existing one-active-membership-per-user rule
  -- (customer_users_one_active_membership_per_user, 20260906120000) is
  -- enforced by a unique index regardless; checking it here turns what
  -- would surface as a raw 23505 into a stable, translatable message.
  -- The second check covers an INACTIVE membership in this same customer,
  -- which the index would not catch but customer_users_customer_user_key
  -- would.
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

  -- Passes the table's own triggers unchanged: customer_id and email are
  -- untouched (identity protection), and the validation trigger's
  -- manager/role checks only fire when those columns change while its
  -- already-a-member check is INSERT-only — which is exactly why
  -- acceptance can set ACCEPTED at the moment a membership starts
  -- existing. status and accepted_at move together, satisfying
  -- customer_user_invitations_accepted_at_matches_status.
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

commit;
