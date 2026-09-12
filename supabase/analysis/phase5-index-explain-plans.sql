-- ============================================================================
-- Phase 5 — Index candidate EXPLAIN (ANALYZE, BUFFERS) scripts
-- ============================================================================
--
-- NOT A MIGRATION. Lives in supabase/analysis/, not supabase/migrations/, on
-- purpose — this is a read-only diagnostic exercise. Nothing here should be
-- committed as schema until a candidate is justified by real plan output.
--
-- Every section below:
--   1. Simulates a specific NON-ADMIN user for RLS purposes (the recursive
--      RLS cost this whole exercise is chasing only shows up for non-ADMIN —
--      an ADMIN short-circuits inside is_customer_user_visible() before ever
--      reaching the recursive CTE, so testing as ADMIN would tell us nothing).
--   2. Runs EXPLAIN (ANALYZE, BUFFERS) BEFORE the candidate index exists —
--      baseline, using whatever indexes already exist today.
--   3. Creates the candidate index CONCURRENTLY (safe on a live/shared
--      database — doesn't take the exclusive lock a plain CREATE INDEX
--      would). CONCURRENTLY cannot run inside a transaction block, so it's
--      a bare top-level statement — do not wrap it in BEGIN/COMMIT.
--   4. Re-runs the identical EXPLAIN — compare against step 2's plan.
--   5. DROPs the test index — cleanup, so nothing lingers from this
--      experiment. Only skip this step for whichever candidate(s) you
--      decide to promote into a real migration afterward.
--
-- ----------------------------------------------------------------------------
-- SETUP — run once, fill in the two values every section below needs
-- ----------------------------------------------------------------------------
--
-- Find a real non-ADMIN user to test as (any of MANAGER / SENIOR_SALES_REP /
-- SALES_REP — all three take the identical recursive-CTE path inside
-- is_customer_user_visible(), only ADMIN short-circuits, so any one of the
-- three is representative):
--
--   select cu.user_id, cu.customer_id, r.name as role_name, cu.name
--   from customer_users cu
--   join roles r on r.id = cu.role_id
--   where r.name <> 'ADMIN' and cu.status = 'Active'
--   order by r.name
--   limit 10;
--
-- Pick one row. Every section below needs that row's user_id (as
-- :non_admin_user_id) and customer_id (as :customer_id). If you're running
-- this in the Supabase SQL editor (no psql variables), just find-and-replace
-- the two placeholder literals throughout this file instead.
--
-- Ideally pick a non-ADMIN user with a NON-TRIVIAL reporting hierarchy under
-- them (a MANAGER or SENIOR_SALES_REP with real descendants) — a SALES_REP
-- with no reports makes is_customer_user_visible()'s recursive CTE walk a
-- trivial one-row case, which understates the cost these indexes are being
-- evaluated against. This:
--
--   select cu.id, cu.name, r.name as role_name,
--          (select count(*) from customer_users d where d.manager_id = cu.id) as direct_reports
--   from customer_users cu
--   join roles r on r.id = cu.role_id
--   where r.name in ('MANAGER', 'SENIOR_SALES_REP') and cu.status = 'Active'
--   order by direct_reports desc
--   limit 10;
--
-- finds the best candidate.
--
-- The RLS-simulation technique below (SET role authenticated + SET
-- request.jwt.claims) is Supabase's own documented pattern for testing RLS
-- policies directly in SQL — see "Testing your policies" in the Supabase
-- RLS docs. It's session-level here (not SET LOCAL), so it persists across
-- statements in the same SQL editor session/connection; RESET at the very
-- end of this file puts the session back to normal.
--
-- ----------------------------------------------------------------------------

-- Replace both literals below with the real values from the SETUP queries
-- above, then run this once per SQL editor session before any EXPLAIN block.
SET role authenticated;
SET request.jwt.claims = '{"sub": "<NON_ADMIN_USER_ID>", "role": "authenticated"}';

-- Sanity check — should print the non-admin user's own id, not null and not
-- the id of whoever you're actually logged into the SQL editor as.
SELECT auth.uid() AS acting_as;


-- ============================================================================
-- CANDIDATE 1 — leads(customer_id, owner_id)
-- ============================================================================
-- Supports the `leads` SELECT RLS policy:
--   is_customer_admin(customer_id)
--     or (owner_id is not null and is_customer_user_visible(owner_id))
-- For a non-admin, is_customer_admin(customer_id) evaluates false, so the
-- effective per-row predicate is `owner_id is not null and
-- is_customer_user_visible(owner_id)` — a FUNCTION CALL, not a plain
-- comparison. My own expectation (to be confirmed by the real plan, not
-- assumed): a composite index on (customer_id, owner_id) is a sargable-
-- filter optimization, but is_customer_user_visible(owner_id) isn't a
-- sargable operator the planner can push into an index condition — so I'd
-- predict this index gets IGNORED for this specific predicate, and the
-- "Filter" line in both the before and after plans stays essentially
-- identical (same is_customer_user_visible() calls, same "Rows Removed by
-- Filter" count). The customer_id-only index already narrows to one
-- tenant's rows before that filter runs; adding owner_id to it doesn't make
-- the per-row function call itself any cheaper. If the real plan
-- disagrees with this, that's the important finding — say so.
--
-- Target query 1 of 2: Pipeline's getLeadsForCustomer() — UNBOUNDED,
-- select("*"), still exactly as Phase 3 found it (Pipeline was explicitly
-- out of scope for Phase 3's column-projection work). This is the query
-- you specifically asked to test here, separately from the Phase 2
-- picker/label queries below, since Pipeline runs this on every single
-- navigation to /sales-management today, well before Phase 10 (if it ever
-- happens) would change that.

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT *
FROM leads
WHERE customer_id = '<CUSTOMER_ID>'
ORDER BY updated_at DESC;

-- Target query 2 of 2: the Phase 2 Lead picker/filter (searchLeadsForPicker)
-- and the Phase 2/3 bounded label lookup (getLeadLabelsByIds) — both also
-- scan `leads` filtered by customer_id, both also pay the same RLS filter.
-- Empty-query picker case (the "show something on focus" path — no search
-- text, so no additional WHERE clause beyond customer_id):

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, contact_name, company, email, phone
FROM leads
WHERE customer_id = '<CUSTOMER_ID>'
ORDER BY updated_at DESC
LIMIT 50;

-- Bounded label lookup (Contacts/Tasks row badges — a handful of specific
-- ids, not a range scan; substitute 2-3 real lead ids from this customer):

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, contact_name, company
FROM leads
WHERE customer_id = '<CUSTOMER_ID>'
  AND id IN ('<LEAD_ID_1>', '<LEAD_ID_2>', '<LEAD_ID_3>');

-- Now create the candidate index and re-run all three above.
-- NOTE: CONCURRENTLY cannot run inside a transaction/BEGIN block.

CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_test_leads_customer_owner
  ON leads (customer_id, owner_id);

-- Re-run the same three EXPLAIN blocks above verbatim, then compare.

-- Cleanup (run once you're done comparing this candidate):
DROP INDEX CONCURRENTLY IF EXISTS zz_test_leads_customer_owner;


-- ============================================================================
-- CANDIDATE 2 — contacts(customer_id, owner_id)
-- ============================================================================
-- Supports the `contacts` SELECT RLS policy, which — unlike leads' — has NO
-- is_customer_admin() branch at all:
--   using (is_customer_user_visible(owner_id))
-- Every contacts row, ADMIN or not, is filtered through this one function
-- call (ADMIN still short-circuits INSIDE is_customer_user_visible() itself,
-- but the policy always calls it). Same expectation as Candidate 1 and for
-- the same reason: not a sargable predicate, so I'd predict the composite
-- doesn't change the Filter step — confirm with the real plan.
--
-- Target: getContactsPage's row fetch (Phase 3 column list) — the
-- paginated, searched, Lead-filtered query ContactList actually issues.
-- No search text, no Lead filter — the plain "just paginate" case:

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, lead_id, owner_id, name, company, title, email, phone, tags
FROM contacts
WHERE customer_id = '<CUSTOMER_ID>'
ORDER BY created_at DESC
LIMIT 10 OFFSET 0;

-- The COUNT half of the same request — Phase 0 flagged count:"exact" as the
-- specific suspect for RLS cost, since counting requires evaluating the
-- filter across every matching row, not just the 10 returned:

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM contacts
WHERE customer_id = '<CUSTOMER_ID>';

-- With an active search + Lead filter (the more realistic "toolbar in use"
-- case — replace the search term with something that actually matches a
-- few rows for this customer):

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, lead_id, owner_id, name, company, title, email, phone, tags
FROM contacts
WHERE customer_id = '<CUSTOMER_ID>'
  AND lead_id = '<LEAD_ID_1>'
  AND (
    name ILIKE '%ravi%' OR company ILIKE '%ravi%' OR email ILIKE '%ravi%'
    OR phone ILIKE '%ravi%' OR title ILIKE '%ravi%'
  )
ORDER BY created_at DESC
LIMIT 10 OFFSET 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_test_contacts_customer_owner
  ON contacts (customer_id, owner_id);

-- Re-run the three EXPLAIN blocks above verbatim, then compare.

DROP INDEX CONCURRENTLY IF EXISTS zz_test_contacts_customer_owner;


-- ============================================================================
-- CANDIDATE 3 — tasks(customer_id, assigned_to)
-- ============================================================================
-- Supports the `tasks` SELECT RLS policy, same shape as contacts':
--   using (is_customer_user_visible(assigned_to))
-- Same expectation, same reasoning as Candidates 1 and 2 — confirm with the
-- real plan rather than trust this.
--
-- Target: getTasksBucketPage's row fetch for one bucket (Phase 3 column
-- list) — the "Overdue" bucket, no other filters active:

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, lead_id, subject, description, priority, due_date, assigned_to, type, status, created_at
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date < CURRENT_DATE
ORDER BY due_date ASC
LIMIT 10 OFFSET 0;

-- The COUNT half — Tasks runs this THREE TIMES per page load (once per
-- visible bucket) when Due Date = "All", the default view:

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date < CURRENT_DATE;

-- With Owner + Status + Type filters active (the fuller toolbar-in-use
-- case):

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, lead_id, subject, description, priority, due_date, assigned_to, type, status, created_at
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date < CURRENT_DATE
  AND status = 'Pending'
  AND assigned_to = '<CUSTOMER_USER_ID>'
ORDER BY due_date ASC
LIMIT 10 OFFSET 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_test_tasks_customer_assigned
  ON tasks (customer_id, assigned_to);

-- Re-run the three EXPLAIN blocks above verbatim, then compare.

DROP INDEX CONCURRENTLY IF EXISTS zz_test_tasks_customer_assigned;


-- ============================================================================
-- CANDIDATE 4 — tasks(customer_id, due_date)
-- ============================================================================
-- STRUCTURALLY DIFFERENT from Candidates 1-3, and worth reading that way:
-- due_date appears in a genuine WHERE-clause comparison (the bucket cutoff:
-- < / = / > CURRENT_DATE) AND in the ORDER BY. Both are ordinary sargable
-- operations on a plain column — nothing to do with the RLS predicate at
-- all. My own expectation here is the OPPOSITE of Candidates 1-3: I'd
-- expect the real plan to show the planner able to use this composite for
-- an Index Scan satisfying both the WHERE and the ORDER BY together
-- (potentially avoiding a separate Sort step), where today it likely does a
-- Bitmap/Index Scan on the existing single-column customer_id or due_date
-- index followed by a sort. This is the strongest of the five candidates
-- on paper — but "on paper" is exactly what this whole exercise exists to
-- check, so confirm rather than take my word for it.
--
-- Same three target queries as Candidate 3 (this index is a candidate for
-- the exact same query shape, just via a different mechanism):

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, lead_id, subject, description, priority, due_date, assigned_to, type, status, created_at
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date < CURRENT_DATE
ORDER BY due_date ASC
LIMIT 10 OFFSET 0;

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date < CURRENT_DATE;

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, lead_id, subject, description, priority, due_date, assigned_to, type, status, created_at
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date < CURRENT_DATE
  AND status = 'Pending'
  AND assigned_to = '<CUSTOMER_USER_ID>'
ORDER BY due_date ASC
LIMIT 10 OFFSET 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_test_tasks_customer_duedate
  ON tasks (customer_id, due_date);

-- Re-run the three EXPLAIN blocks above verbatim, then compare.
--
-- If you want to test Candidates 3 and 4 TOGETHER (both indexes present at
-- once — the realistic end state if both get promoted to a migration), run
-- this section's CREATE INDEX without having dropped Candidate 3's yet, and
-- re-run all three queries a third time.

DROP INDEX CONCURRENTLY IF EXISTS zz_test_tasks_customer_duedate;


-- ============================================================================
-- CANDIDATE 5 — leads(created_at)
-- ============================================================================
-- CORRECTION TO MY OWN PHASE 0 AUDIT: I originally claimed this index would
-- help "Pipeline ordering/pagination." That was wrong — re-checked
-- features/leads/lib/get-leads.ts just now: Pipeline's getLeadsForCustomer()
-- orders by UPDATED_AT, not created_at:
--
--   .order("updated_at", { ascending: false })
--
-- Nothing in the current codebase filters or sorts the `leads` table by
-- created_at anywhere. Grepped to confirm before writing this. So I expect
-- this exact index, AS NAMED, to go completely unused by every current
-- query — there's no WHERE or ORDER BY clause anywhere for the planner to
-- match it against. Testing it below anyway, exactly as originally named,
-- since you asked me not to substitute:

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT *
FROM leads
WHERE customer_id = '<CUSTOMER_ID>'
ORDER BY updated_at DESC;

CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_test_leads_created_at
  ON leads (created_at);

-- Re-run the EXPLAIN above. My prediction: identical plan, index not
-- referenced anywhere in it (Postgres has no reason to touch an index on a
-- column that appears in neither the WHERE nor the ORDER BY of this
-- query). If the plan DOES reference it, that's a real surprise worth
-- reporting back, not something to wave away.

DROP INDEX CONCURRENTLY IF EXISTS zz_test_leads_created_at;

-- ---- OPTIONAL — NOT one of the original five, your call whether to run it
-- ----
-- If the actual goal was accelerating Pipeline's real ORDER BY (updated_at,
-- not created_at), the column-corrected candidate would be a COMPOSITE on
-- (customer_id, updated_at) — same shape and same reasoning as Candidate 4
-- above, just for leads/updated_at instead of tasks/due_date. Offered here
-- only as an option; I have not treated it as part of the required five and
-- won't put it in a migration without you separately asking for it.

-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
-- SELECT *
-- FROM leads
-- WHERE customer_id = '<CUSTOMER_ID>'
-- ORDER BY updated_at DESC;
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS zz_test_leads_customer_updated
--   ON leads (customer_id, updated_at);
--
-- -- Re-run the EXPLAIN above.
--
-- DROP INDEX CONCURRENTLY IF EXISTS zz_test_leads_customer_updated;


-- ============================================================================
-- CLEANUP — restore the session to normal
-- ============================================================================

RESET role;
RESET request.jwt.claims;

-- Confirm every zz_test_ index was actually dropped (should return 0 rows —
-- if anything shows up here, one of the DROP INDEX steps above didn't run):
SELECT indexname FROM pg_indexes WHERE indexname LIKE 'zz_test_%';
