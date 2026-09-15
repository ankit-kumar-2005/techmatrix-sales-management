-- ---------------------------------------------------------------------
-- FORECAST AGGREGATES — four read-only rollups, computed in the
-- database.
--
-- WHY THESE EXIST AT ALL: the Forecast page needs sums over every deal
-- a user can see. Fetching those deals and reducing them in JavaScript
-- (what the Pipeline page still does) is an unbounded read that grows
-- with the tenant, and this project has already paid for that mistake
-- once. Each function below is a single GROUP BY that returns at most a
-- handful of rows: one per stage, one per rep, one per month.
--
-- =====================================================================
-- SECURITY INVOKER — AND THAT IS THE WHOLE POINT
-- =====================================================================
-- Every other get_* function in this schema (get_visible_team_directory,
-- get_invitation_context, get_pending_invitation_for_current_user) is
-- SECURITY DEFINER, because each one has to read something RLS hides
-- from the caller: auth.users, or an ADMIN-only invitation row.
--
-- These four are the exact opposite case and are deliberately NOT
-- SECURITY DEFINER. public.leads already carries precisely the policy a
-- forecast needs:
--
--     "hierarchy-aware lead visibility" (20260906120000)
--        using (is_customer_admin(customer_id)
--               or (owner_id is not null
--                   and is_customer_user_visible(owner_id)))
--
-- Running as the INVOKER means that policy — plus "customer members can
-- view their customer's lead stages" on customer_lead_stages — is
-- evaluated inside these function bodies, by the database, for the real
-- caller. Consequences, all of them intended:
--
--   * ADMIN aggregates their whole customer, including unassigned deals
--     (owner_id is null), which that policy admits only for an admin.
--   * MANAGER / SENIOR_SALES_REP aggregate themselves plus their
--     recursive manager_id descendants.
--   * SALES_REP has no descendants, so they aggregate their own deals
--     and nothing else — as an emergent property of the existing
--     recursive definition, NOT a role branch written here.
--   * There is no customer_id parameter on any of these functions.
--     There is nothing to pass and nothing to forge: the tenant is
--     whatever RLS says it is. A crafted call cannot widen the scope,
--     because there is no argument through which to try.
--   * Role-based visibility is therefore defined in exactly one place
--     in this codebase, and it is not here.
--
-- A SECURITY DEFINER version of these would have had to re-implement
-- that hierarchy predicate by hand — a second copy of the single most
-- security-critical rule in the application. That is the specific
-- outcome this design avoids.
--
-- `stable` (not volatile): pure reads, so the planner may cache within
-- a statement. `set search_path = public` on each, matching this
-- schema's convention for every function, even non-DEFINER ones.
--
-- =====================================================================
-- SHARED DEFINITIONS, IDENTICAL IN ALL FOUR
-- =====================================================================
--   OPEN DEAL      l.status = 'Active' AND cls.is_closed = false.
--                  status='Active' mirrors the Pipeline page, which
--                  filters activeLeads before every KPI — an Inactive
--                  lead is archived and must not be forecast.
--   WEIGHTED VALUE coalesce(l.deal_value, 0) * cls.probability / 100.0
--                  deal_value is nullable (NULL = "not provided",
--                  distinct from a real zero) and is treated as 0 for
--                  aggregation only, exactly as the Pipeline page's own
--                  sum() already does. Never rendered as a fabricated
--                  "Rs 0" against an individual deal.
--                  /100.0 forces numeric division; /100 would truncate
--                  to zero for every deal under Rs 100.
--   WON            cls.is_won — the real column added in
--                  20260916120000, not a name match.
--   LOST           cls.is_closed AND NOT cls.is_won. Excluded from
--                  every figure in every function here: a lost deal
--                  will never close, so it is not forecast, not best
--                  case, and not closed-won.
--
-- KNOWN LIMITATION, ACCEPTED: "this month" and the month buckets are
-- computed from current_date in the DATABASE's timezone (UTC on
-- Supabase). For a tenant in IST this can differ from their local month
-- for up to 5.5 hours around a month boundary. There is no per-tenant
-- timezone column in this schema and adding one is out of scope for
-- Forecast; documented here rather than silently assumed correct.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

-- =====================================================================
-- 1. SUMMARY — the four headline KPI cards, in one table scan.
--
-- Deliberately its own function rather than derived in the application
-- from the by-stage and by-month rollups, for one reason: "expected to
-- close this month" needs a month boundary, and computing that boundary
-- in the database (once, next to the data) instead of in TypeScript
-- keeps a single definition of "this month" for the card and the chart.
--
-- Every figure comes from the same scan via aggregate FILTER clauses,
-- so the four numbers can never be computed against four different
-- snapshots of the table.
-- =====================================================================

create or replace function public.get_forecast_summary()
returns table (
  weighted_forecast numeric,
  best_case numeric,
  open_deal_count bigint,
  closed_won_value numeric,
  closed_won_count bigint,
  expected_this_month_value numeric,
  expected_this_month_count bigint,
  -- The honesty counter the Forecast page surfaces under its chart:
  -- OPEN deals with no expected close date, which is why the monthly
  -- bars do not sum to weighted_forecast. Undated deals land in no
  -- month bucket at all, so this is the only place that count exists.
  --
  -- There is deliberately NO overdue counter here.
  -- get_forecast_by_month()'s OVERDUE bucket already returns that count
  -- against an identical predicate, and two sources for one number is
  -- precisely how the two drift apart. If something ever needs it,
  -- read that bucket.
  undated_open_count bigint
)
language sql
stable
set search_path = public
as $$
  select
    coalesce(sum(coalesce(l.deal_value, 0) * cls.probability / 100.0)
             filter (where not cls.is_closed), 0),
    coalesce(sum(coalesce(l.deal_value, 0))
             filter (where not cls.is_closed), 0),
    count(*) filter (where not cls.is_closed),

    -- Won only. Raw deal_value, not weighted: a won deal's probability
    -- is pinned to 100 by CHECK anyway, so weighting it would be a
    -- no-op that merely invited the two to drift.
    coalesce(sum(coalesce(l.deal_value, 0)) filter (where cls.is_won), 0),
    count(*) filter (where cls.is_won),

    -- Open deals whose expected close date lands in the current
    -- calendar month. Weighted, per the spec.
    coalesce(sum(coalesce(l.deal_value, 0) * cls.probability / 100.0)
             filter (where not cls.is_closed
                       and l.expected_close_date >= date_trunc('month', current_date)::date
                       and l.expected_close_date <  (date_trunc('month', current_date) + interval '1 month')::date), 0),
    count(*) filter (where not cls.is_closed
                       and l.expected_close_date >= date_trunc('month', current_date)::date
                       and l.expected_close_date <  (date_trunc('month', current_date) + interval '1 month')::date),

    count(*) filter (where not cls.is_closed and l.expected_close_date is null)
  from public.leads l
  join public.customer_lead_stages cls on cls.id = l.stage_id
  where l.status = 'Active';
$$;

revoke all on function public.get_forecast_summary() from public, anon;
grant execute on function public.get_forecast_summary() to authenticated;

-- =====================================================================
-- 2. BY STAGE — one row per configured stage.
--
-- LEFT JOIN from customer_lead_stages, not an inner join from leads, so
-- a stage holding zero deals still returns a row (0 deals, Rs 0). The
-- Forecast by Stage table is a view of the customer's CONFIGURATION as
-- much as of their data — a stage silently vanishing because it happens
-- to be empty today would read as a missing stage, and would also hide
-- the 0%-probability stages an admin most needs to notice and fix.
--
-- Closed stages (Won, Lost, and any custom terminal stage) are returned
-- too, carrying their real counts: open_deal_count is 0 for them by
-- definition, but total_value/weighted_value let the table show
-- Closed-Won's contribution. The page decides what to render; the
-- function does not editorialise.
--
-- Returns the stage's identity columns (display_order, is_closed,
-- is_won, probability) because the UI needs all four: display_order to
-- drive the existing stage color palette in
-- features/leads/lib/stage-colors.ts, is_closed/is_won for the badge,
-- probability for its own column.
-- =====================================================================

create or replace function public.get_forecast_by_stage()
returns table (
  stage_id uuid,
  stage text,
  display_order integer,
  status text,
  is_closed boolean,
  is_won boolean,
  probability smallint,
  open_deal_count bigint,
  total_value numeric,
  weighted_value numeric
)
language sql
stable
set search_path = public
as $$
  select
    cls.id,
    cls.stage,
    cls.display_order,
    cls.status,
    cls.is_closed,
    cls.is_won,
    cls.probability,
    count(l.id) filter (where not cls.is_closed),
    coalesce(sum(coalesce(l.deal_value, 0)), 0),
    coalesce(sum(coalesce(l.deal_value, 0) * cls.probability / 100.0), 0)
  from public.customer_lead_stages cls
  -- The status filter belongs in the JOIN condition, not a WHERE: in a
  -- WHERE clause it would discard the whole stage row whenever every
  -- one of its leads is Inactive, defeating the LEFT JOIN above.
  left join public.leads l
    on l.stage_id = cls.id
   and l.status = 'Active'
  group by cls.id, cls.stage, cls.display_order, cls.status, cls.is_closed, cls.is_won, cls.probability
  order by cls.display_order;
$$;

revoke all on function public.get_forecast_by_stage() from public, anon;
grant execute on function public.get_forecast_by_stage() to authenticated;

-- =====================================================================
-- 3. BY REP — one row per deal owner, OPEN deals only.
--
-- owner_id is nullable and is returned as NULL for unassigned deals.
-- That row can only ever appear for an ADMIN: "hierarchy-aware lead
-- visibility" admits a lead with owner_id IS NULL through its
-- is_customer_admin branch alone, so RLS — not this function — is what
-- keeps an unassigned deal out of a manager's or rep's rollup.
--
-- No display name is returned. Resolving an owner to a label is already
-- owned by getOwnerDisplayLabels() in features/leads/lib/owner-display.ts
-- (name, falling back to email, with a "(email)" suffix on collisions),
-- fed by the existing get_visible_team_directory() RPC. Duplicating any
-- of that here would put email addresses in a second place and let two
-- screens disagree about what one person is called.
-- =====================================================================

create or replace function public.get_forecast_by_owner()
returns table (
  owner_id uuid,
  open_deal_count bigint,
  best_case numeric,
  weighted_forecast numeric
)
language sql
stable
set search_path = public
as $$
  select
    l.owner_id,
    count(*),
    coalesce(sum(coalesce(l.deal_value, 0)), 0),
    coalesce(sum(coalesce(l.deal_value, 0) * cls.probability / 100.0), 0)
  from public.leads l
  join public.customer_lead_stages cls on cls.id = l.stage_id
  where l.status = 'Active'
    and not cls.is_closed
  group by l.owner_id
  order by 4 desc;
$$;

revoke all on function public.get_forecast_by_owner() from public, anon;
grant execute on function public.get_forecast_by_owner() to authenticated;

-- =====================================================================
-- 4. BY MONTH — the trend chart, bucketed by expected close date.
--
-- THREE KINDS OF BUCKET, so that no open deal is silently invisible:
--
--   'OVERDUE'  one row. Open deals whose expected close date is already
--              in a past month. Its own LEADING bucket rather than
--              being folded in with undated deals, because the two are
--              different situations: an overdue deal has a date that
--              SLIPPED (actionable, and the thing a manager most wants
--              to see), while an undated deal is a data-hygiene gap.
--              month_start is NULL for this row.
--   'MONTH'    p_months rows, current month first. Generated from
--              generate_series, NOT from the deals themselves, so a
--              month with no deals still returns a zero row — a chart
--              whose bars silently reflow because an empty month
--              vanished is worse than a visible zero.
--   'LATER'    one row. Open deals dated beyond the generated window.
--              Exists purely so the page can account for them instead
--              of dropping them off the end. month_start is NULL.
--
-- Deals with NO expected close date appear in none of these (they have
-- nothing to bucket by); get_forecast_summary().undated_open_count is
-- what reports them.
--
-- p_months is clamped to 1..24. It is a display window, not an
-- authorization input — it cannot widen what the caller may see, since
-- RLS is what decides that — but an unclamped value could still ask the
-- database to generate an absurd series, so it is bounded here rather
-- than trusted.
-- =====================================================================

create or replace function public.get_forecast_by_month(p_months integer default 6)
returns table (
  bucket text,
  month_start date,
  weighted_value numeric,
  open_deal_count bigint
)
language sql
stable
set search_path = public
as $$
  with bounds as (
    select
      date_trunc('month', current_date)::date as first_month,
      least(greatest(coalesce(p_months, 6), 1), 24) as month_count
  ),
  -- Every open, dated deal reduced to just the two values the buckets
  -- need. Scanned once; each branch below joins against it.
  open_deals as (
    select
      l.expected_close_date as close_date,
      coalesce(l.deal_value, 0) * cls.probability / 100.0 as weighted
    from public.leads l
    join public.customer_lead_stages cls on cls.id = l.stage_id
    where l.status = 'Active'
      and not cls.is_closed
      and l.expected_close_date is not null
  ),
  months as (
    select (b.first_month + (month_offset || ' months')::interval)::date as month_start
    from bounds b,
         generate_series(0, b.month_count - 1) as month_offset
  ),
  buckets as (
    select
      0 as sort_key,
      'OVERDUE'::text as bucket,
      null::date as month_start,
      coalesce(sum(d.weighted), 0) as weighted_value,
      count(d.close_date) as open_deal_count
    from bounds b
    left join open_deals d on d.close_date < b.first_month

    union all

    select
      1,
      'MONTH'::text,
      m.month_start,
      coalesce(sum(d.weighted), 0),
      count(d.close_date)
    from months m
    left join open_deals d
      on d.close_date >= m.month_start
     and d.close_date <  (m.month_start + interval '1 month')::date
    group by m.month_start

    union all

    select
      2,
      'LATER'::text,
      null::date,
      coalesce(sum(d.weighted), 0),
      count(d.close_date)
    from bounds b
    left join open_deals d
      on d.close_date >= (b.first_month + (b.month_count || ' months')::interval)::date
  )
  -- Wrapped so the ordering can use sort_key without returning it: a
  -- UNION's own ORDER BY may only reference output columns, and both
  -- NULL-month buckets would otherwise be unorderable against each
  -- other.
  select bucket, month_start, weighted_value, open_deal_count
  from buckets
  order by sort_key, month_start;
$$;

revoke all on function public.get_forecast_by_month(integer) from public, anon;
grant execute on function public.get_forecast_by_month(integer) to authenticated;

commit;
