-- ============================================================================
-- Phase 2 — customer_user_invitations backend verification suite
-- ============================================================================
--
-- NOT A MIGRATION. Diagnostic/verification SQL, run by hand in the
-- Supabase SQL Editor, same posture as phase5-index-explain-plans.sql
-- and phase6-count-explain-plans.sql.
--
-- WHY THIS IS A SQL SCRIPT AND NOT A TEST SUITE: this project has no
-- test runner (no vitest/jest/playwright, no `test` script in
-- package.json), and the environment these were written in has no
-- database access at all. Every case below is therefore written to be
-- executed BY YOU. Nothing in this file has been run.
--
-- Cases 10 and 11 (the 60-second resend cooldown) are deliberately NOT
-- here: that throttle lives in resendInvitationAction, not in the
-- database, because what is being rate-limited is sending an email —
-- see that action's own comment. Exercise those two through the app.
--
-- ----------------------------------------------------------------------------
-- SETUP — fill these in first.
--
-- Use the QA accounts from supabase/analysis/test-account-seed.sql if you
-- ran it; otherwise any real customer + admin will do. Every :'name'
-- below is a psql variable — in the Supabase SQL Editor, just replace the
-- placeholder text directly.
-- ----------------------------------------------------------------------------

-- Handy lookups to fill in the placeholders:
--   select cu.customer_id, cu.id as admin_customer_user_id, cu.user_id as admin_auth_user_id, r.name
--   from customer_users cu join roles r on r.id = cu.role_id
--   where r.name = 'ADMIN' and cu.status = 'Active';
--
--   select id, name from roles;

-- <CUSTOMER_A>             uuid of the customer under test
-- <ADMIN_AUTH_USER_ID>     auth.users.id of an ADMIN of CUSTOMER_A
-- <NONADMIN_AUTH_USER_ID>  auth.users.id of a non-ADMIN member of CUSTOMER_A
-- <SALES_REP_ROLE_ID>      roles.id where name = 'SALES_REP'
-- <MANAGER_CU_ID>          an ACTIVE customer_users.id inside CUSTOMER_A
-- <CUSTOMER_B>             a DIFFERENT customer's id (tenant-isolation tests)
-- <CUSTOMER_B_CU_ID>       a customer_users.id inside CUSTOMER_B


-- ============================================================================
-- SECTION 1 — constraints and triggers (run as the SQL Editor's default
-- role; these fire for every role, RLS is not involved)
-- ============================================================================

-- TEST 1 — admin creates an invitation. Expect: one PENDING row, and NO
-- customer_users row for that email.
insert into public.customer_user_invitations
  (customer_id, email, full_name, role_id, invited_by)
values
  ('<CUSTOMER_A>', 'John@Example.com', 'John Tester', '<SALES_REP_ROLE_ID>', '<ADMIN_AUTH_USER_ID>');

select id, email, status, invited_at, last_sent_at, expires_at,
       accepted_at, accepted_customer_user_id
from public.customer_user_invitations
where customer_id = '<CUSTOMER_A>' and lower(btrim(email)) = 'john@example.com';
-- EXPECT: status = 'PENDING', accepted_at IS NULL,
--         accepted_customer_user_id IS NULL, expires_at ≈ invited_at + 1h.

select count(*) as should_be_zero
from public.customer_users cu
join auth.users u on u.id = cu.user_id
where cu.customer_id = '<CUSTOMER_A>' and lower(btrim(u.email)) = 'john@example.com';
-- EXPECT: 0 — a PENDING invitation creates no membership.


-- TEST 3 — duplicate PENDING invitation, same casing.
-- TEST 4 (variant) — and TEST 3's case/whitespace variant.
do $$
begin
  begin
    insert into public.customer_user_invitations
      (customer_id, email, full_name, role_id, invited_by)
    values ('<CUSTOMER_A>', 'john@example.com', 'John Again', '<SALES_REP_ROLE_ID>', '<ADMIN_AUTH_USER_ID>');
    raise notice 'TEST 3  FAIL — duplicate PENDING invitation was allowed';
  exception when unique_violation then
    raise notice 'TEST 3  PASS — %', sqlerrm;
  end;

  begin
    insert into public.customer_user_invitations
      (customer_id, email, full_name, role_id, invited_by)
    values ('<CUSTOMER_A>', '  JOHN@EXAMPLE.COM  ', 'John Shouty', '<SALES_REP_ROLE_ID>', '<ADMIN_AUTH_USER_ID>');
    raise notice 'TEST 3b FAIL — case/whitespace variant was allowed';
  exception when unique_violation then
    raise notice 'TEST 3b PASS — normalized duplicate rejected';
  end;
end $$;


-- TEST 4 — email already belongs to a member of THIS customer.
-- Substitute the email of any existing member of CUSTOMER_A.
do $$
begin
  insert into public.customer_user_invitations
    (customer_id, email, full_name, role_id, invited_by)
  values ('<CUSTOMER_A>', '<EXISTING_MEMBER_EMAIL>', 'Already Here', '<SALES_REP_ROLE_ID>', '<ADMIN_AUTH_USER_ID>');
  raise notice 'TEST 4  FAIL — invited an existing member';
exception when others then
  raise notice 'TEST 4  PASS — %', sqlerrm;
end $$;
-- EXPECT: "A user with this email address is already a member of this customer."
-- The Server Action translates that to the specified UI message.


-- TEST 5 — same email invited by a DIFFERENT tenant. This must SUCCEED:
-- invitations are per-customer, and blocking it would leak cross-tenant
-- user existence. The one-active-membership rule is enforced at
-- acceptance instead (TEST 15b below).
insert into public.customer_user_invitations
  (customer_id, email, full_name, role_id, invited_by)
values ('<CUSTOMER_B>', 'john@example.com', 'John Tester',
        (select id from public.roles where name = 'SALES_REP'), '<ADMIN_AUTH_USER_ID>');
-- EXPECT: succeeds. (invited_by here is just an auditing reference; use a
-- CUSTOMER_B admin's id if you want it realistic.)


-- TESTS 6, 7, 8, 9 — role and manager validation.
do $$
begin
  begin  -- TEST 6: role_id that doesn't exist
    insert into public.customer_user_invitations
      (customer_id, email, full_name, role_id, invited_by)
    values ('<CUSTOMER_A>', 't6@example.com', 'T6', gen_random_uuid(), '<ADMIN_AUTH_USER_ID>');
    raise notice 'TEST 6  FAIL — unknown role accepted';
  exception when foreign_key_violation then
    raise notice 'TEST 6  PASS — role FK rejected it';
  end;

  begin  -- TEST 8: manager_id that doesn't exist
    insert into public.customer_user_invitations
      (customer_id, email, full_name, role_id, manager_id, invited_by)
    values ('<CUSTOMER_A>', 't8@example.com', 'T8', '<SALES_REP_ROLE_ID>', gen_random_uuid(), '<ADMIN_AUTH_USER_ID>');
    raise notice 'TEST 8  FAIL — unknown manager accepted';
  exception when foreign_key_violation then
    raise notice 'TEST 8  PASS — manager FK rejected it';
  end;

  begin  -- TEST 9: manager belonging to ANOTHER tenant
    insert into public.customer_user_invitations
      (customer_id, email, full_name, role_id, manager_id, invited_by)
    values ('<CUSTOMER_A>', 't9@example.com', 'T9', '<SALES_REP_ROLE_ID>', '<CUSTOMER_B_CU_ID>', '<ADMIN_AUTH_USER_ID>');
    raise notice 'TEST 9  FAIL — CROSS-TENANT MANAGER ACCEPTED (critical)';
  exception when foreign_key_violation then
    raise notice 'TEST 9  PASS — composite FK blocked cross-tenant manager';
  end;
end $$;

-- TEST 7 — inactive role. Temporarily retire a role, try to invite into
-- it, then put it back. Run the three statements together.
update public.roles set status = 'Inactive' where id = '<SALES_REP_ROLE_ID>';
do $$
begin
  insert into public.customer_user_invitations
    (customer_id, email, full_name, role_id, invited_by)
  values ('<CUSTOMER_A>', 't7@example.com', 'T7', '<SALES_REP_ROLE_ID>', '<ADMIN_AUTH_USER_ID>');
  raise notice 'TEST 7  FAIL — invited into an inactive role';
exception when others then
  raise notice 'TEST 7  PASS — %', sqlerrm;
end $$;
update public.roles set status = 'Active' where id = '<SALES_REP_ROLE_ID>';

-- TEST 8b — inactive manager (the part no foreign key can express).
update public.customer_users set status = 'Inactive' where id = '<MANAGER_CU_ID>';
do $$
begin
  insert into public.customer_user_invitations
    (customer_id, email, full_name, role_id, manager_id, invited_by)
  values ('<CUSTOMER_A>', 't8b@example.com', 'T8b', '<SALES_REP_ROLE_ID>', '<MANAGER_CU_ID>', '<ADMIN_AUTH_USER_ID>');
  raise notice 'TEST 8b FAIL — inactive manager accepted';
exception when others then
  raise notice 'TEST 8b PASS — %', sqlerrm;
end $$;
update public.customer_users set status = 'Active' where id = '<MANAGER_CU_ID>';


-- ============================================================================
-- SECTION 2 — RLS (these MUST run as `authenticated`; as the default
-- superuser role RLS is bypassed and every one of them would pass
-- vacuously)
-- ============================================================================

-- TEST 21 — ADMIN sees their own customer's invitations.
set role authenticated;
set request.jwt.claims = '{"sub": "<ADMIN_AUTH_USER_ID>", "role": "authenticated"}';

select auth.uid() as acting_as;                               -- sanity check
select count(*) as admin_visible from public.customer_user_invitations;
-- EXPECT: every invitation of CUSTOMER_A, and nothing from CUSTOMER_B.

select count(*) as should_be_zero
from public.customer_user_invitations where customer_id = '<CUSTOMER_B>';
-- TEST 20 — EXPECT 0. Tenant isolation.

-- TEST 20b — an admin cannot write into another tenant either.
do $$
begin
  insert into public.customer_user_invitations
    (customer_id, email, full_name, role_id, invited_by)
  values ('<CUSTOMER_B>', 'crosstenant@example.com', 'Nope', '<SALES_REP_ROLE_ID>', '<ADMIN_AUTH_USER_ID>');
  raise notice 'TEST 20b FAIL — CROSS-TENANT INSERT ALLOWED (critical)';
exception when insufficient_privilege then
  raise notice 'TEST 20b PASS — RLS blocked cross-tenant insert';
end $$;

reset role;
reset request.jwt.claims;

-- TESTS 2 + 22 — a non-admin can neither see nor manage invitations.
set role authenticated;
set request.jwt.claims = '{"sub": "<NONADMIN_AUTH_USER_ID>", "role": "authenticated"}';

select count(*) as should_be_zero from public.customer_user_invitations;
-- TEST 22 — EXPECT 0 rows, even for their own customer.

do $$
begin
  insert into public.customer_user_invitations
    (customer_id, email, full_name, role_id, invited_by)
  values ('<CUSTOMER_A>', 'nonadmin@example.com', 'Nope', '<SALES_REP_ROLE_ID>', '<NONADMIN_AUTH_USER_ID>');
  raise notice 'TEST 2  FAIL — NON-ADMIN CREATED AN INVITATION (critical)';
exception when insufficient_privilege then
  raise notice 'TEST 2  PASS — RLS blocked non-admin insert';
end $$;

reset role;
reset request.jwt.claims;


-- ============================================================================
-- SECTION 3 — acceptance (accept_customer_user_invitation)
--
-- Needs a REAL auth user whose email matches an invitation, and who has
-- no active membership anywhere. Create one via Dashboard → Authentication
-- → Add user (see test-account-seed.sql STEP 1), then invite that exact
-- address from SECTION 1 and note the invitation's id.
-- ============================================================================

-- <INVITEE_AUTH_USER_ID>  the new auth user's id
-- <INVITATION_ID>         a PENDING invitation addressed to that user's email

set role authenticated;
set request.jwt.claims = '{"sub": "<INVITEE_AUTH_USER_ID>", "role": "authenticated"}';

-- TEST 12 — expired invitation. Push it into the past first (as the
-- owner role, since the invitee cannot update invitations), then retry.
--   reset role; update public.customer_user_invitations
--     set expires_at = now() - interval '1 minute' where id = '<INVITATION_ID>';
--   -- then set role authenticated again and run:
select public.accept_customer_user_invitation('<INVITATION_ID>');
-- EXPECT: ERROR "This invitation has expired."
-- Put it back with: expires_at = now() + interval '1 hour'.

-- TEST 13 — cancelled invitation. Set status = 'CANCELLED' as the owner
-- role, then retry the call above.
-- EXPECT: ERROR "This invitation has been cancelled."
-- Put it back with: status = 'PENDING'.

-- TEST 14 — successful acceptance.
select public.accept_customer_user_invitation('<INVITATION_ID>') as new_customer_user_id;
-- EXPECT: returns a uuid.

reset role;
reset request.jwt.claims;

-- TESTS 16, 17, 18, 19 — verify the resulting state.
select
  i.status,
  i.accepted_at,
  i.accepted_customer_user_id,
  cu.id            as membership_id,
  cu.status        as membership_status,
  cu.role_id       = i.role_id     as role_matches_invitation,
  cu.manager_id    is not distinct from i.manager_id as manager_matches_invitation,
  cu.customer_id   = i.customer_id as tenant_matches_invitation
from public.customer_user_invitations i
left join public.customer_users cu on cu.id = i.accepted_customer_user_id
where i.id = '<INVITATION_ID>';
-- EXPECT: status 'ACCEPTED' (TEST 17), accepted_at NOT NULL (TEST 18),
--         accepted_customer_user_id NOT NULL (TEST 19), membership_status
--         'Active', and all three *_matches columns true.

select count(*) as should_be_exactly_one
from public.customer_users
where user_id = '<INVITEE_AUTH_USER_ID>';
-- TEST 16 — EXPECT exactly 1. Acceptance creates one membership, no more.

-- TEST 15 — duplicate acceptance by the SAME user is idempotent.
set role authenticated;
set request.jwt.claims = '{"sub": "<INVITEE_AUTH_USER_ID>", "role": "authenticated"}';
select public.accept_customer_user_invitation('<INVITATION_ID>') as same_id_again;
-- EXPECT: returns the SAME uuid as TEST 14, no error, and still exactly
-- one membership (re-run the count above to confirm).

-- TEST 15b — the same user accepting a SECOND invitation (e.g. the
-- CUSTOMER_B one from TEST 5) must be refused: one active membership per
-- user is the existing invariant and acceptance must not break it.
select public.accept_customer_user_invitation('<CUSTOMER_B_INVITATION_ID>');
-- EXPECT: ERROR "This account already belongs to an organization."

-- TEST 15c — somebody else's invitation must not be acceptable, and the
-- error must not confirm whether that invitation exists.
select public.accept_customer_user_invitation('<SOMEONE_ELSES_INVITATION_ID>');
-- EXPECT: ERROR "This invitation is not valid for your account."
-- The SAME message is returned for a completely made-up id:
select public.accept_customer_user_invitation(gen_random_uuid());
-- EXPECT: identical error text — no existence oracle.

reset role;
reset request.jwt.claims;


-- ============================================================================
-- CLEANUP — remove everything this suite created.
-- ============================================================================

-- delete from public.customer_user_invitations
--  where email in ('John@Example.com', 'john@example.com', 't6@example.com',
--                  't7@example.com', 't8@example.com', 't8b@example.com',
--                  't9@example.com', 'nonadmin@example.com',
--                  'crosstenant@example.com');
-- -- and, if TEST 14 ran, the membership it created:
-- delete from public.customer_users where user_id = '<INVITEE_AUTH_USER_ID>';
