-- Run these in the Supabase SQL Editor BEFORE applying
-- 20260919120000_lead_capture_integrations.sql. Not a migration itself,
-- and not applied by the CLI — same convention as
-- PRE_MIGRATION_CHECKS.sql (the existing file in this same directory,
-- from the team_directory_names incident). Delete this file once you're
-- done with it.
--
-- WHY THIS EXISTS: Claude has no live database connection in this
-- environment — no psql, no Supabase CLI session, no MCP database tool.
-- Every finding in the accompanying review is based on reading the
-- migration FILES under supabase/migrations/, not on querying the
-- actual database. Those two can disagree — this project has direct
-- precedent for that (see PRE_MIGRATION_CHECKS.sql's own history) — so
-- this is the only way to close that gap: run this, and paste the
-- results back.

-- 1. Does a table shaped like "Customer Integration" already exist —
--    under THIS name or a different one? Lists every table in `public`
--    whose name contains "integration", so a differently-named
--    pre-existing table is caught too, not just an exact match.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name ilike '%integration%';
-- Expect (if this migration has never been applied AND you have no
-- other integration-shaped table): 0 rows.
-- If you get rows back, STOP and paste them here — this is the
-- "Customer Integration" table you already have, and the plan needs to
-- reconcile against its REAL shape rather than assume this migration's
-- customer_integrations is the same thing.

-- 2. If a customer_integrations table already exists (under that exact
--    name), what are its actual columns, types and nullability? Compare
--    this against the migration's CREATE TABLE statement by eye.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'customer_integrations'
order by ordinal_position;
-- Expect: 0 rows if check 1 above was also 0 rows. If check 1 found a
-- customer_integrations table, this tells you its exact shape.

-- 3. Same for customer_integration_participants.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'customer_integration_participants'
order by ordinal_position;
-- Expect: 0 rows.

-- 4. Do the three NEW leads columns this migration adds already exist?
--    Checked individually because a PARTIAL prior application (a
--    migration that started, added some columns, then failed or was
--    interrupted before the CREATE TABLE statements) would show some
--    but not all of these.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'leads'
  and column_name in ('notes', 'external_source_id', 'address');
-- Expect: 0 rows. Any row here means that specific column already
-- exists — the migration's `alter table ... add column` for that one
-- column would fail outright (Postgres rejects adding a column that's
-- already there), so the migration cannot be applied as-is if this
-- returns anything.

-- 5. Does the dedupe index already exist?
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and indexname = 'leads_external_source_unique';
-- Expect: 0 rows.

-- 6. Does EITHER function name exist — the new one this migration
--    creates, or the old one from an earlier draft of it (in case an
--    earlier version was applied by hand before the generic rewrite)?
select
  p.oid::regprocedure as function_signature,
  pg_get_function_result(p.oid) as return_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('ingest_lead', 'ingest_indiamart_lead');
-- Expect: 0 rows. If ingest_indiamart_lead shows up, an earlier draft
-- of this migration was already applied and this needs a corrective
-- migration (ALTER/DROP+CREATE), not a fresh CREATE TABLE — reusing
-- this file's CREATE TABLE statements against an already-populated
-- customer_integrations would either fail outright (table exists) or,
-- if somehow re-run, do nothing useful.

-- 7. Does anything already reference customer_integrations or
--    customer_integration_participants — a view, another function, a
--    foreign key from a table this review doesn't know about? Mirrors
--    PRE_MIGRATION_CHECKS.sql's own dependency check.
select
  classid::regclass as dependent_catalog,
  objid,
  deptype
from pg_depend
where refobjid in (
  select oid from pg_class
  where relnamespace = 'public'::regnamespace
    and relname in ('customer_integrations', 'customer_integration_participants')
)
and deptype != 'i';
-- Expect: 0 rows (or: this query itself errors with "table does not
-- exist" if check 1 was 0 rows, which is also fine — it means there is
-- nothing to depend on yet).

-- 8. Sanity check on the ONE existing table this migration alters —
--    confirm current leads columns, so "preserve existing columns" can
--    be verified by eye against what's added vs. what's already there.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'leads'
order by ordinal_position;
