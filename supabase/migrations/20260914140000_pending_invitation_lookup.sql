-- Lets a signed-in user find out whether THEY THEMSELVES have a pending
-- invitation waiting — nothing more.
--
-- Adds exactly one read-only function. No table, column, policy, index,
-- trigger or prior migration is touched. 20260914120000's schema and
-- 20260914130000's acceptance function are both used as-is.
--
-- WHY THIS IS NEEDED AT ALL: RLS on customer_user_invitations is
-- ADMIN-of-that-customer only ("admins can view their customer's
-- invitations"), which is correct and stays. The consequence is that an
-- INVITEE — who is not an admin, and not yet a member of anything —
-- cannot see their own invitation row. That is fine for acceptance
-- (accept_customer_user_invitation is SECURITY DEFINER and looks it up
-- on their behalf), but it left one gap:
--
--   An invited person who ignores the invitation email and instead signs
--   up normally reaches /set-password, whose form calls
--   create_customer_with_admin() — creating a BRAND NEW customer with
--   themselves as its ADMIN. The existing one-active-membership-per-user
--   rule then makes their real invitation permanently unacceptable.
--   The application had no way to detect that case, because it could not
--   see the invitation.
--
-- This function closes exactly that gap and nothing else.
--
-- SECURITY REVIEW:
--   * Returns ONE uuid: the id of an invitation addressed to the
--     CALLER'S OWN verified email. It exposes no customer, company,
--     role, manager, inviter or any other tenant's data, and an
--     invitation id is an identifier rather than a secret — holding one
--     grants nothing without also being signed in as that exact email
--     (see 20260914130000's own note on why there is no token).
--   * The email is read from auth.users for auth.uid() — never accepted
--     as a parameter. The function takes NO parameters at all, so there
--     is nothing a caller can vary: you can only ever ask about
--     yourself. That is the single most important property here.
--   * auth.uid() is null for an unauthenticated caller, so the join
--     yields no rows and the result is null; execute is additionally
--     revoked from public and anon.
--   * `set search_path = public` pins name resolution, matching every
--     other SECURITY DEFINER function in this schema.
--   * `stable` and read-only: it cannot write, and cannot be used to
--     create, accept, cancel or modify anything.
--   * Expired invitations are excluded here the same way
--     accept_customer_user_invitation excludes them — by the clock as
--     well as the stored status, since no sweep job writes 'EXPIRED'.
--
-- Ordering note: the partial unique index is per (customer_id, email),
-- so the same address can legitimately hold one pending invitation from
-- each of several customers. The newest is returned; acceptance still
-- re-validates everything, so this only decides which invitation the
-- user is shown first.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

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

commit;
