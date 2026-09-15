-- ---------------------------------------------------------------------
-- get_invitation_context() — return the invited person's NAME as well.
--
-- WHY: the invitation screen now opens on "You're Invited" and shows who
-- the invitation is for before asking for a password. The name already
-- lives on customer_user_invitations.full_name (the admin typed it in
-- Add User); nothing new is stored, and it is the same value
-- accept_customer_user_invitation() copies into customer_users.name, so
-- the screen cannot show one name and create another.
--
-- REUSED, NEVER RECREATED: the table, its RLS, the acceptance RPC and
-- get_pending_invitation_for_current_user() are all untouched. This
-- migration changes exactly one read-only, display-only function.
--
-- DROP-then-CREATE rather than CREATE OR REPLACE: Postgres refuses to
-- replace a function whose RETURNS TABLE signature changes. The drop and
-- the create are in one transaction, so the function is never missing
-- outside of it.
--
-- DISCLOSURE IS UNCHANGED: the new column follows exactly the same rule
-- as company_name/role_name/manager_name — populated only when the
-- caller's VERIFIED email matches the invited address, NULL for everyone
-- else. A link-holder who is not the invitee still learns nothing beyond
-- the masked email hint they already got.
-- ---------------------------------------------------------------------

begin;

drop function if exists public.get_invitation_context(uuid);

create function public.get_invitation_context(p_invitation_id uuid)
returns table (
  matches_current_user boolean,
  invited_email_hint text,
  invited_full_name text,
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
  v_full_name text := null;
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
    v_full_name := v_invitation.full_name;

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

  return query select v_matches, v_hint, v_full_name, v_company, v_role, v_manager, v_status;
end;
$$;

revoke all on function public.get_invitation_context(uuid) from public, anon;
grant execute on function public.get_invitation_context(uuid) to authenticated;

commit;
