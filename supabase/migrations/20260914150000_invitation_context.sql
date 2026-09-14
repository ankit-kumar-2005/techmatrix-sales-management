-- Lets the acceptance page tell the invitee WHOSE invitation this is,
-- and — critically — whether the account currently signed in on this
-- browser is that person.
--
-- Adds exactly one read-only function. No table, column, policy, index,
-- trigger or prior migration is touched.
--
-- WHY THIS IS NEEDED: RLS on customer_user_invitations is ADMIN-of-that-
-- customer only, which is correct and stays. The consequence is that the
-- acceptance page could not read the invitation at all, so it had no way
-- to compare the invited address against the session's. It therefore
-- rendered "Signed in as <whoever>" plus an enabled Accept button for
-- ANY session — including the admin who sent the invitation, still
-- signed in in the same browser. The acceptance RPC always refused that
-- correctly, so nothing unsafe ever happened; the failure was that the
-- mismatch could only be discovered by clicking a button that was
-- guaranteed to fail.
--
-- GRADUATED DISCLOSURE — the security posture of this function:
--   * anon cannot execute it at all, and auth.uid() = null returns zero
--     rows. An unauthenticated visitor learns nothing, exactly as before.
--   * A signed-in caller whose email does NOT match learns only
--     `matches_current_user = false` plus a MASKED hint (r***l@acme.com).
--     No company, role, manager or status is returned. That is strictly
--     less than they already learn by pressing Accept.
--   * Only a caller whose VERIFIED email matches the invitation gets the
--     company name, role, manager and status — and they are by
--     definition the invited person, reading their own invitation.
--   * Read-only (`stable`), returns no ids of any kind, and grants
--     nothing: acceptance still goes exclusively through
--     accept_customer_user_invitation(), which re-validates everything.
--   * `set search_path = public` pins name resolution, matching every
--     other SECURITY DEFINER function in this schema.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

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
  -- Unauthenticated callers learn nothing. Zero rows, not an error:
  -- the page treats "no context" as "behave exactly as before".
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

    -- Same "status plus the clock" rule accept_customer_user_invitation
    -- applies, because no sweep job ever writes 'EXPIRED'.
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
