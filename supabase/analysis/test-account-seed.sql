-- ============================================================================
-- Non-ADMIN test account + data seed
-- ============================================================================
--
-- NOT A MIGRATION. Same posture as phase5-index-explain-plans.sql and
-- phase6-count-explain-plans.sql — diagnostic/fixture SQL, run by hand in
-- the Supabase SQL Editor, never applied via the CLI migration mechanism,
-- never committed as part of the app's schema history.
--
-- WHY THIS EXISTS: Phase 4 (RLS rewrite, needs before/after equivalence
-- testing across all four roles) and Phase 5 (index EXPLAIN plans, needs a
-- non-ADMIN JWT to simulate) and Phase 6 Section B (count-cost under the
-- real recursive RLS predicate, not the ADMIN short-circuit) all separately
-- need the same thing: non-ADMIN accounts with real reporting-hierarchy
-- data underneath them. This script produces that once, so it only has to
-- be done once.
--
-- WHAT IT BUILDS — a 4-level-deep hierarchy under your existing customer:
--
--   ADMIN (already exists)
--     -> MANAGER            "QA Test Manager"
--          -> SENIOR_SALES_REP  "QA Test Senior Rep"   (reports to Manager)
--          -> SALES_REP         "QA Test Sales Rep"    (reports to Manager)
--
-- This exercises every role in the security-regression checklist that's
-- been carried through this whole engagement (ADMIN / MANAGER /
-- SENIOR_SALES_REP / SALES_REP) and gives MANAGER a real, non-trivial
-- recursive case (2 descendants) rather than a leaf.
--
-- ALL SEEDED DATA IS CLEARLY MARKED so it's trivial to find and remove
-- later and impossible to mistake for real customer data:
--   * auth emails: qa-manager@techmatrix.test / qa-senior-rep@techmatrix.test
--     / qa-sales-rep@techmatrix.test  (the .test TLD is reserved by ICANN
--     for exactly this — it can never resolve to a real domain)
--   * every seeded row's user-visible text is prefixed "QA TEST —"
--
-- ----------------------------------------------------------------------------
-- STEP 1 — create the three auth users (do this in the Supabase Dashboard,
-- not SQL: Authentication -> Users -> Add user). Inserting directly into
-- auth.users via SQL is NOT recommended by Supabase — the Dashboard/Admin
-- API path correctly creates the matching auth.identities row and handles
-- password hashing; a raw SQL insert into auth.users does not.
--
--   1. qa-manager@techmatrix.test       (set any password, check "Auto Confirm User")
--   2. qa-senior-rep@techmatrix.test    (same)
--   3. qa-sales-rep@techmatrix.test     (same)
--
-- Then copy each one's UUID (shown in the Dashboard's user list, or via
-- the query below) into the DO block in STEP 2.
-- ----------------------------------------------------------------------------

-- Optional: confirms the three users exist and gives you their UUIDs to
-- paste into STEP 2, without needing to leave the SQL Editor.
select id, email
from auth.users
where email in (
  'qa-manager@techmatrix.test',
  'qa-senior-rep@techmatrix.test',
  'qa-sales-rep@techmatrix.test'
);

-- ----------------------------------------------------------------------------
-- STEP 2 — link them into customer_users under your existing ADMIN's
-- customer, and seed a handful of leads/contacts/tasks owned across them.
--
-- Run this whole block as-is (as `postgres`, the SQL Editor's default
-- role) — it bypasses RLS the same way every other migration in this
-- project does for its own inserts (table owner / superuser bypass RLS by
-- default; nothing here sets FORCE ROW LEVEL SECURITY). This is
-- deliberate: customer_users has NO INSERT policy for `authenticated`
-- at all (see 20260904140000's own design notes — the only sanctioned
-- door is create_customer_with_admin(), which only ever creates an ADMIN
-- row) — there is no RLS-respecting way to create a MANAGER/SALES_REP
-- membership today, because the invitation system that would normally do
-- this doesn't exist yet (see app/(app)/settings/add-user/page.tsx's own
-- "UI structure only" comment). Running as postgres is the same
-- privilege level the eventual invitation RPC would need anyway.
-- ----------------------------------------------------------------------------

do $$
declare
  -- PASTE the three UUIDs from the query above (or the Dashboard) here:
  v_manager_user_id  uuid := '<PASTE_MANAGER_AUTH_USER_ID>';
  v_senior_user_id   uuid := '<PASTE_SENIOR_REP_AUTH_USER_ID>';
  v_rep_user_id      uuid := '<PASTE_SALES_REP_AUTH_USER_ID>';

  v_customer_id      uuid;
  v_admin_cu_id      uuid;
  v_admin_count      integer;

  v_manager_role_id  uuid;
  v_senior_role_id   uuid;
  v_rep_role_id      uuid;

  v_manager_cu_id    uuid;
  v_senior_cu_id     uuid;
  v_rep_cu_id        uuid;

  v_stage_new_id     uuid;
  v_stage_qualified_id uuid;
  v_stage_proposal_id  uuid;

  v_lead_1 uuid; v_lead_2 uuid; v_lead_3 uuid;
  v_lead_4 uuid; v_lead_5 uuid; v_lead_6 uuid;
begin
  -- ------------------------------------------------------------------
  -- Resolve the target customer from the existing ADMIN. Guards against
  -- silently seeding into the wrong tenant if more than one customer
  -- happens to exist by the time this runs.
  -- ------------------------------------------------------------------
  select count(*) into v_admin_count
  from public.customer_users cu
  join public.roles r on r.id = cu.role_id
  where r.name = 'ADMIN' and cu.status = 'Active';

  if v_admin_count = 0 then
    raise exception 'No active ADMIN found — nothing to seed under.';
  elsif v_admin_count > 1 then
    raise exception 'More than one active ADMIN exists (%). Set v_customer_id explicitly instead of auto-resolving it.', v_admin_count;
  end if;

  select cu.customer_id, cu.id into v_customer_id, v_admin_cu_id
  from public.customer_users cu
  join public.roles r on r.id = cu.role_id
  where r.name = 'ADMIN' and cu.status = 'Active';

  select id into v_manager_role_id from public.roles where name = 'MANAGER';
  select id into v_senior_role_id from public.roles where name = 'SENIOR_SALES_REP';
  select id into v_rep_role_id from public.roles where name = 'SALES_REP';

  -- ------------------------------------------------------------------
  -- customer_users — the hierarchy. manager_id is set to build:
  --   ADMIN -> MANAGER -> { SENIOR_SALES_REP, SALES_REP }
  -- ------------------------------------------------------------------
  insert into public.customer_users (customer_id, user_id, role_id, manager_id, name, status)
  values (v_customer_id, v_manager_user_id, v_manager_role_id, v_admin_cu_id, 'QA Test Manager', 'Active')
  returning id into v_manager_cu_id;

  insert into public.customer_users (customer_id, user_id, role_id, manager_id, name, status)
  values (v_customer_id, v_senior_user_id, v_senior_role_id, v_manager_cu_id, 'QA Test Senior Rep', 'Active')
  returning id into v_senior_cu_id;

  insert into public.customer_users (customer_id, user_id, role_id, manager_id, name, status)
  values (v_customer_id, v_rep_user_id, v_rep_role_id, v_manager_cu_id, 'QA Test Sales Rep', 'Active')
  returning id into v_rep_cu_id;

  -- ------------------------------------------------------------------
  -- Resolve a few of this customer's existing lead stages (every
  -- customer gets New/Contacted/Qualified/Proposal/Won/Lost seeded at
  -- creation by create_customer_with_admin() — see
  -- 20260908120000_customer_and_user_names.sql).
  -- ------------------------------------------------------------------
  select id into v_stage_new_id from public.customer_lead_stages where customer_id = v_customer_id and stage = 'New';
  select id into v_stage_qualified_id from public.customer_lead_stages where customer_id = v_customer_id and stage = 'Qualified';
  select id into v_stage_proposal_id from public.customer_lead_stages where customer_id = v_customer_id and stage = 'Proposal';

  if v_stage_new_id is null then
    raise exception 'Could not resolve a "New" lead stage for customer %. Check customer_lead_stages.', v_customer_id;
  end if;

  -- ------------------------------------------------------------------
  -- Leads — 2 owned by each of the three new users (6 total). Deliberately
  -- small/hand-authored so Phase 4's before/after RLS equivalence checks
  -- can be eyeballed row-by-row. See the OPTIONAL bulk-volume block below
  -- if Phase 5 needs more rows for the planner to prefer an index over a
  -- seq scan.
  -- ------------------------------------------------------------------
  insert into public.leads (customer_id, company, contact_name, deal_value, stage_id, owner_id, source, next_step, status)
  values (v_customer_id, 'QA TEST — Meridian Foods', 'Priya Shah', 18000, v_stage_new_id, v_manager_cu_id, 'Referral', 'Schedule intro call', 'Active')
  returning id into v_lead_1;

  insert into public.leads (customer_id, company, contact_name, deal_value, stage_id, owner_id, source, next_step, status)
  values (v_customer_id, 'QA TEST — Harborline Logistics', 'Tom Reyes', 42000, v_stage_qualified_id, v_manager_cu_id, 'Website', 'Send proposal', 'Active')
  returning id into v_lead_2;

  insert into public.leads (customer_id, company, contact_name, deal_value, stage_id, owner_id, source, next_step, status)
  values (v_customer_id, 'QA TEST — Alderbrook Clinics', 'Nina Patel', 9500, v_stage_new_id, v_senior_cu_id, 'Cold outreach', 'Follow up Friday', 'Active')
  returning id into v_lead_3;

  insert into public.leads (customer_id, company, contact_name, deal_value, stage_id, owner_id, source, next_step, status)
  values (v_customer_id, 'QA TEST — Crestview Realty', 'Owen Blake', 27500, v_stage_proposal_id, v_senior_cu_id, 'Referral', 'Await signature', 'Active')
  returning id into v_lead_4;

  insert into public.leads (customer_id, company, contact_name, deal_value, stage_id, owner_id, source, next_step, status)
  values (v_customer_id, 'QA TEST — Basalt Hardware', 'Grace Kim', 6200, v_stage_new_id, v_rep_cu_id, 'Trade show', 'Send catalog', 'Active')
  returning id into v_lead_5;

  insert into public.leads (customer_id, company, contact_name, deal_value, stage_id, owner_id, source, next_step, status)
  values (v_customer_id, 'QA TEST — Fernwood Dental Group', 'Sam Ortiz', 15300, v_stage_qualified_id, v_rep_cu_id, 'Website', 'Book demo', 'Active')
  returning id into v_lead_6;

  -- ------------------------------------------------------------------
  -- Contacts — deliberately includes the "contact owned by someone
  -- other than the lead's own owner" case the contacts migration's
  -- design notes call out explicitly (a Manager's lead, contact owned by
  -- one of the Manager's reports).
  -- ------------------------------------------------------------------
  insert into public.contacts (customer_id, lead_id, owner_id, name, company, title, email, phone, tags)
  values (v_customer_id, v_lead_1, v_manager_cu_id, 'QA TEST — Priya Shah', 'Meridian Foods', 'Ops Director', 'priya.shah.qa@techmatrix.test', '555-0101', array['decision-maker']);

  insert into public.contacts (customer_id, lead_id, owner_id, name, company, title, email, phone, tags)
  values (v_customer_id, v_lead_2, v_senior_cu_id, 'QA TEST — Tom Reyes', 'Harborline Logistics', 'Procurement Lead', 'tom.reyes.qa@techmatrix.test', '555-0102', array['procurement']);

  insert into public.contacts (customer_id, lead_id, owner_id, name, company, title, email, phone, tags)
  values (v_customer_id, v_lead_3, v_senior_cu_id, 'QA TEST — Nina Patel', 'Alderbrook Clinics', 'Practice Manager', 'nina.patel.qa@techmatrix.test', '555-0103', array['decision-maker']);

  insert into public.contacts (customer_id, lead_id, owner_id, name, company, title, email, phone, tags)
  values (v_customer_id, v_lead_5, v_rep_cu_id, 'QA TEST — Grace Kim', 'Basalt Hardware', 'Owner', 'grace.kim.qa@techmatrix.test', '555-0104', array['decision-maker']);

  insert into public.contacts (customer_id, lead_id, owner_id, name, company, title, email, phone, tags)
  values (v_customer_id, v_lead_6, v_rep_cu_id, 'QA TEST — Sam Ortiz', 'Fernwood Dental Group', 'Office Manager', 'sam.ortiz.qa@techmatrix.test', '555-0105', array['influencer']);

  -- ------------------------------------------------------------------
  -- Tasks — spread across the three due-date buckets Tasks pages fetch
  -- (Overdue / Today / Upcoming), so all three bucket queries have real
  -- rows to count/paginate for Phase 6 Section B.
  -- ------------------------------------------------------------------
  insert into public.tasks (customer_id, lead_id, subject, description, priority, due_date, assigned_to, type, status)
  values (v_customer_id, v_lead_1, 'QA TEST — Call Priya re: intro', 'Seeded test task', 'High', current_date - 3, v_manager_cu_id, 'Call', 'Pending');

  insert into public.tasks (customer_id, lead_id, subject, description, priority, due_date, assigned_to, type, status)
  values (v_customer_id, v_lead_2, 'QA TEST — Send Harborline proposal', 'Seeded test task', 'Medium', current_date, v_manager_cu_id, 'Email', 'Pending');

  insert into public.tasks (customer_id, lead_id, subject, description, priority, due_date, assigned_to, type, status)
  values (v_customer_id, v_lead_3, 'QA TEST — Follow up with Alderbrook', 'Seeded test task', 'Low', current_date + 5, v_senior_cu_id, 'Call', 'Pending');

  insert into public.tasks (customer_id, lead_id, subject, description, priority, due_date, assigned_to, type, status)
  values (v_customer_id, v_lead_4, 'QA TEST — Check Crestview signature', 'Seeded test task', 'Medium', current_date, v_senior_cu_id, 'Other', 'Pending');

  insert into public.tasks (customer_id, lead_id, subject, description, priority, due_date, assigned_to, type, status)
  values (v_customer_id, v_lead_5, 'QA TEST — Ship Basalt catalog', 'Seeded test task', 'Low', current_date - 1, v_rep_cu_id, 'Email', 'Pending');

  insert into public.tasks (customer_id, lead_id, subject, description, priority, due_date, assigned_to, type, status)
  values (v_customer_id, v_lead_6, 'QA TEST — Book Fernwood demo', 'Seeded test task', 'High', current_date + 2, v_rep_cu_id, 'Meeting', 'Pending');

  raise notice 'Seeded customer_users: manager=%, senior_rep=%, sales_rep=% under customer %', v_manager_cu_id, v_senior_cu_id, v_rep_cu_id, v_customer_id;
end $$;

-- ----------------------------------------------------------------------------
-- STEP 3 — verify. Shows the hierarchy and per-user row counts so you can
-- eyeball that it landed correctly before using it for Phase 4/5/6.
-- ----------------------------------------------------------------------------

select
  cu.id as customer_user_id,
  cu.name,
  r.name as role,
  cu.manager_id,
  (select count(*) from public.leads l where l.owner_id = cu.id) as leads_owned,
  (select count(*) from public.contacts c where c.owner_id = cu.id) as contacts_owned,
  (select count(*) from public.tasks t where t.assigned_to = cu.id) as tasks_assigned
from public.customer_users cu
join public.roles r on r.id = cu.role_id
where cu.name like 'QA Test%'
order by r.name;

-- ----------------------------------------------------------------------------
-- OPTIONAL — bulk volume for Phase 5's EXPLAIN plans specifically. The
-- hand-authored 6 leads / 5 contacts / 6 tasks above are enough for Phase
-- 4's row-by-row correctness checks, but likely too few rows for Postgres's
-- planner to ever prefer an index scan over a sequential scan (a seq scan
-- is often cheaper below a few hundred/thousand rows regardless of what
-- indexes exist — that would make Phase 5's plans look identical
-- with-or-without an index for the wrong reason: not enough data, not "the
-- index doesn't help"). Uncomment and run ONLY if Phase 5's baseline plans
-- come back showing seq scans on tables this small. Generates 500 more
-- leads split across the three test owners, tagged the same "QA TEST —"
-- way, easy to remove with the same cleanup step below.
-- ----------------------------------------------------------------------------

-- do $$
-- declare
--   v_customer_id uuid;
--   v_owner_ids uuid[];
--   v_stage_id uuid;
-- begin
--   select cu.customer_id into v_customer_id
--   from public.customer_users cu where cu.name = 'QA Test Manager';
--
--   select array_agg(id) into v_owner_ids
--   from public.customer_users where name like 'QA Test%';
--
--   select id into v_stage_id from public.customer_lead_stages
--   where customer_id = v_customer_id and stage = 'New';
--
--   insert into public.leads (customer_id, company, contact_name, deal_value, stage_id, owner_id, source, status)
--   select
--     v_customer_id,
--     'QA TEST BULK — Company ' || i,
--     'Bulk Contact ' || i,
--     (random() * 50000)::numeric(12,2),
--     v_stage_id,
--     v_owner_ids[1 + (i % array_length(v_owner_ids, 1))],
--     'Bulk seed',
--     'Active'
--   from generate_series(1, 500) as i;
-- end $$;

-- ============================================================================
-- CLEANUP — run when Phase 4/5/6 are done with this data. Deletes in
-- FK-safe order (children before parents). All matched purely by the
-- "QA TEST"/"QA Test" markers above, so this can never touch real data.
-- ============================================================================

-- delete from public.tasks where subject like 'QA TEST%';
-- delete from public.contacts where name like 'QA TEST%';
-- delete from public.leads where company like 'QA TEST%';
-- delete from public.customer_users where name like 'QA Test%';
-- -- Then delete the three auth users via Dashboard (Authentication -> Users
-- -- -> delete) rather than SQL — customer_users.user_id already cascades
-- -- from auth.users on delete, so deleting them there is also sufficient
-- -- on its own and removes the need to run the customer_users delete above
-- -- separately.
