-- Run these in the Supabase SQL Editor BEFORE applying the corrected
-- 20260909120000_team_directory_names.sql. Not a migration itself —
-- delete this file once you're done with it.

-- 1. Confirm customer_users.name exists (added by 20260908120000,
--    which is a separate migration from the one that just failed —
--    this checks whether THAT one actually succeeded).
select column_name, is_nullable, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'customer_users'
  and column_name = 'name';
-- Expect: 1 row, is_nullable = 'YES'.
-- If this returns 0 rows, STOP — 20260908120000 hasn't been applied
-- yet either, and needs to go in before this one.

-- 2. Confirm the CURRENT (pre-fix) shape of both RPCs — this tells you
--    whether the failed first attempt left them as the original
--    6-column functions (expected, since the failing statement's
--    transaction should have rolled back) or something else.
select
  p.oid::regprocedure as function_signature,
  pg_get_function_result(p.oid) as return_shape
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_customer_team_directory', 'get_visible_team_directory');
-- Expect: 2 rows, each still showing the OLD 6-column TABLE shape
-- (customer_user_id, user_id, email, role_name, manager_id, status) —
-- no `name` column yet. If you already see `name` in there, the
-- corrected migration doesn't need to run again.

-- 3. Confirm nothing else in the database depends on either function
--    before the corrected migration drops and recreates them.
select
  classid::regclass as dependent_catalog,
  objid,
  deptype
from pg_depend
where refobjid in (
  select oid from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname in ('get_customer_team_directory', 'get_visible_team_directory')
)
and deptype != 'i'; -- 'i' = internal dependency on itself; ignore
-- Expect: 0 rows. Any row here means something else references one of
-- these functions and the DROP would fail (or cascade) — investigate
-- before proceeding if so.
