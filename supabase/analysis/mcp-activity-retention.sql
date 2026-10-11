-- ============================================================================
-- MCP activity retention — daily 90-day cleanup (MANUAL, NOT A MIGRATION)
-- ============================================================================
--
-- Same posture as the other files in supabase/analysis/: reviewed and run by
-- hand in the Supabase SQL editor, never applied by the migration process.
-- Run it only AFTER 20261010120000_mcp_platform.sql is applied.
--
-- WHAT IT DOES
--   Deletes, once a day, MCP activity older than the documented retention
--   period (90 days, MCP_AUDIT_RETENTION_DAYS in features/mcp/config/limits.ts):
--     * public.mcp_audit_log         rows with created_at older than 90 days
--     * public.mcp_idempotency_keys  rows with created_at older than 90 days
--   Nothing else. No other table is touched, and the age filter means a
--   repeated or overlapping run simply finds nothing left to delete
--   (idempotent).
--
-- WHY THESE TWO TABLES ONLY
--   They are the only MCP tables that grow with usage. Settings, tool
--   switches, blocks and connections are small configuration state and are
--   kept (connections are the audit trail's reference point).
--
-- RUNS AS
--   The role that schedules the job (the SQL editor's `postgres`). The app
--   roles (anon, authenticated) cannot run the function: EXECUTE is revoked,
--   and they have no DELETE privilege on these tables anyway.
--
-- INDEX
--   No created_at-only index is added. The existing indexes lead with the
--   person or company, so the daily delete scans the table. At the volumes
--   expected (bounded by 60 calls/person/minute, realistically thousands of
--   rows per day) that is a sub-second daily scan. Add
--     create index mcp_audit_log_created_at_idx on public.mcp_audit_log (created_at);
--   only if the table grows into the millions of rows and the job is slow —
--   check with: explain analyze select count(*) from public.mcp_audit_log
--                 where created_at < now() - interval '90 days';
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — prerequisites (read-only). Expect: the MCP tables exist, and
-- pg_cron is available (installed or installable).
-- ----------------------------------------------------------------------------

select to_regclass('public.mcp_audit_log') as audit_table,
       to_regclass('public.mcp_idempotency_keys') as idempotency_table;

select name, default_version, installed_version
  from pg_available_extensions
 where name = 'pg_cron';

-- If installed_version is NULL, enable it: Supabase Dashboard → Integrations
-- → Cron (recommended), or run:
--   create extension if not exists pg_cron;
-- (Supabase docs: https://supabase.com/docs/guides/cron/install)


-- ----------------------------------------------------------------------------
-- STEP 1 — the cleanup function. Safe to run more than once.
-- ----------------------------------------------------------------------------

create or replace function public.purge_expired_mcp_activity(retention_days integer default 90)
returns table (audit_rows_deleted bigint, idempotency_rows_deleted bigint)
language plpgsql
set search_path = public
as $$
declare
  v_cutoff timestamptz;
  v_audit bigint;
  v_keys bigint;
begin
  -- Never shorter than 30 days, whatever is passed in: a typo must not
  -- wipe recent activity.
  if retention_days is null or retention_days < 30 then
    raise exception 'retention_days must be at least 30 (got %)', retention_days;
  end if;
  v_cutoff := now() - make_interval(days => retention_days);

  delete from public.mcp_audit_log where created_at < v_cutoff;
  get diagnostics v_audit = row_count;

  delete from public.mcp_idempotency_keys where created_at < v_cutoff;
  get diagnostics v_keys = row_count;

  return query select v_audit, v_keys;
end;
$$;

revoke all on function public.purge_expired_mcp_activity(integer) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- STEP 2 (optional) — dry run: how many rows WOULD be deleted today.
-- ----------------------------------------------------------------------------

select (select count(*) from public.mcp_audit_log        where created_at < now() - interval '90 days') as audit_rows_due,
       (select count(*) from public.mcp_idempotency_keys where created_at < now() - interval '90 days') as idempotency_rows_due;


-- ----------------------------------------------------------------------------
-- STEP 3 — schedule it daily at 03:17 UTC (off-peak, away from the
-- automation cron at 03:00). Re-running with the same job name updates the
-- existing job instead of adding a second one.
-- ----------------------------------------------------------------------------

select cron.schedule(
  'mcp-activity-retention',
  '17 3 * * *',
  $job$select public.purge_expired_mcp_activity(90)$job$
);


-- ----------------------------------------------------------------------------
-- STEP 4 — verify (read-only).
-- ----------------------------------------------------------------------------

select jobid, jobname, schedule, command, active
  from cron.job
 where jobname = 'mcp-activity-retention';

-- After the first run (next day):
-- select status, return_message, start_time, end_time
--   from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'mcp-activity-retention')
--  order by start_time desc
--  limit 5;


-- ----------------------------------------------------------------------------
-- ROLLBACK — stop the job and remove the function. Deleted rows are not
-- recoverable except from backups.
-- ----------------------------------------------------------------------------
-- select cron.unschedule('mcp-activity-retention');
-- drop function if exists public.purge_expired_mcp_activity(integer);


-- ----------------------------------------------------------------------------
-- MANUAL FALLBACK — if pg_cron is unavailable or not wanted: run STEP 1 once,
-- then monthly (or on any schedule you choose):
--   select * from public.purge_expired_mcp_activity(90);
-- Limitation: retention then depends on someone remembering to run it.
-- ----------------------------------------------------------------------------
