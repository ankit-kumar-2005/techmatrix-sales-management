-- Run these in the Supabase SQL Editor BEFORE applying
-- 20260908120000_customer_and_user_names.sql. Not a migration itself —
-- delete this file once you've finished checking (it's not referenced
-- by anything, just a scratch file for the checks below).

-- 1. Confirm exactly one create_customer_with_admin exists today, and
--    that it's the expected 8-argument version.
select
  p.oid::regprocedure as function_signature,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  p.pronargs as arg_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'create_customer_with_admin';
-- Expect: exactly ONE row, arg_count = 8.
-- If this returns 0 rows or more than 1 row, STOP — the assumptions
-- this migration is built on don't hold; report back what you see.

-- 2. Confirm nothing else in the database depends on that function
--    (no trigger, view, or other function references it) before the
--    migration drops it.
select
  classid::regclass as dependent_catalog,
  objid,
  deptype
from pg_depend
where refobjid = (
  select oid from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname = 'create_customer_with_admin'
)
and deptype != 'i'; -- 'i' = internal dependency on itself; ignore
-- Expect: 0 rows. Any row here means something else references this
-- function and DROP FUNCTION would fail (or, worse, cascade) — do not
-- proceed without understanding what that dependency is first.

-- 3. Confirm the columns being added don't already exist (in case an
--    earlier partial/manual attempt already added them).
select table_name, column_name, is_nullable, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('customers', 'customer_users')
  and column_name = 'name';
-- Expect: 0 rows (columns don't exist yet).

-- 4. Confirm auth_email_has_account doesn't already exist under a
--    different signature that might conflict.
select
  p.oid::regprocedure as function_signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'auth_email_has_account';
-- Expect: 0 rows.

-- 5. Spot-check whether customers/customer_users already have rows
--    (informational only — the migration is safe either way, since
--    the new columns are nullable, but worth knowing before you decide
--    whether/when a future NOT NULL + backfill migration makes sense).
select count(*) as customer_count from public.customers;
select count(*) as customer_user_count from public.customer_users;
