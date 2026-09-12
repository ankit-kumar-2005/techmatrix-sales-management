-- ============================================================================
-- Phase 6 — count:"exact" cost measurement
-- ============================================================================
--
-- NOT A MIGRATION. Diagnostic only, same as phase5-index-explain-plans.sql.
--
-- TWO SECTIONS below, and they answer DIFFERENT questions:
--
--   SECTION A — runnable RIGHT NOW with the one ADMIN user that exists
--   today. Isolates the cost of the COUNT OPERATION ITSELF (scanning and
--   tallying every matching row) from the cost of the RLS PREDICATE
--   (is_customer_user_visible(), the recursive CTE). As ADMIN,
--   is_customer_admin(customer_id) short-circuits to true immediately, so
--   these plans show the count's base cost with RLS essentially free —
--   NOT the full non-admin cost. Still real, still useful: if counting is
--   expensive even here, it's expensive for everyone, and it can only get
--   worse for a non-admin who pays the recursive check on top.
--
--   SECTION B — the same queries wrapped in the RLS-simulation technique
--   from Phase 5, for once non-admin test accounts exist. This is what
--   actually answers "how much of the count's cost is the recursive
--   predicate" — Section A alone cannot answer that, and I'm not
--   pretending otherwise.
--
-- ----------------------------------------------------------------------------

-- ============================================================================
-- SECTION A — runnable now (ADMIN, RLS short-circuits, base count cost only)
-- ============================================================================

-- --- CONTACTS ---------------------------------------------------------------
-- Row fetch alone (no count) — the "just show me page 1" cost:
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, lead_id, owner_id, name, company, title, email, phone, tags
FROM contacts
WHERE customer_id = '<CUSTOMER_ID>'
ORDER BY created_at DESC
LIMIT 10 OFFSET 0;

-- The exact count PostgREST issues alongside it:
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM contacts
WHERE customer_id = '<CUSTOMER_ID>';

-- --- TASKS -------------------------------------------------------------
-- Tasks pays this THREE TIMES per page load (Overdue/Today/Upcoming, the
-- default "Due Date = All" view) — each bucket's own row fetch:
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, lead_id, subject, description, priority, due_date, assigned_to, type, status, created_at
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date < CURRENT_DATE
ORDER BY due_date ASC
LIMIT 10 OFFSET 0;

-- ...and each bucket's own separate exact count:
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date < CURRENT_DATE;

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date = CURRENT_DATE;

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>'
  AND due_date > CURRENT_DATE;

-- Informational only, NOT a proposed implementation: what a single merged
-- count (all three buckets in one query, via FILTER) would cost, for
-- comparison against the three separate counts above. If the numbers show
-- the 3x multiplication is the dominant cost (not the per-row RLS
-- predicate), merging these into one client-side-shared count becomes a
-- real option — but that's a bigger architectural change than "which
-- counting mode," and not something to implement inside this phase.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT
  count(*) FILTER (WHERE due_date < CURRENT_DATE) AS overdue_count,
  count(*) FILTER (WHERE due_date = CURRENT_DATE) AS today_count,
  count(*) FILTER (WHERE due_date > CURRENT_DATE) AS upcoming_count
FROM tasks
WHERE customer_id = '<CUSTOMER_ID>';

-- --- CATALOG -----------------------------------------------------------
-- Row fetch alone:
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, name, category, price, pricing_unit, description, status
FROM customer_catalog_items
WHERE customer_id = '<CUSTOMER_ID>'
ORDER BY updated_at DESC
LIMIT 6 OFFSET 0;

-- The exact count:
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT count(*)
FROM customer_catalog_items
WHERE customer_id = '<CUSTOMER_ID>';
-- Reminder: customer_catalog_items' SELECT RLS policy is
-- is_customer_member(customer_id) — a `language sql`, inlining-eligible
-- function, not the recursive plpgsql one. This count was never expected
-- to be the expensive one; it's here as the CONTROL GROUP — if even this
-- shows a meaningful cost at current data volumes, that's a sizing/
-- indexing question, not an RLS one, since there's no recursive predicate
-- here to blame.


-- ============================================================================
-- SECTION B — once non-ADMIN test accounts exist (see phase5's own SETUP
-- section for how to find/pick one with a real reporting hierarchy)
-- ============================================================================

SET role authenticated;
SET request.jwt.claims = '{"sub": "<NON_ADMIN_USER_ID>", "role": "authenticated"}';
SELECT auth.uid() AS acting_as;  -- sanity check

-- Re-run every EXPLAIN block from Section A verbatim here. The delta
-- between a Section A plan and its Section B counterpart for the SAME
-- query is, as closely as EXPLAIN can isolate it, the actual cost of
-- is_customer_user_visible()'s recursive CTE running once per row across
-- the full matching set — the thing Section A structurally cannot show,
-- no matter how carefully it's run.

RESET role;
RESET request.jwt.claims;
