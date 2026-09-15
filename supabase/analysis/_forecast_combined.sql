-- =====================================================================
-- FORECAST - ALL THREE MIGRATIONS, COMBINED FOR A SINGLE PASTE.
--
-- THIS FILE IS A CONVENIENCE ARTIFACT, NOT A MIGRATION.
-- The authoritative, version-controlled migrations are the three files
-- in supabase/migrations/ named below, and they are what any migration
-- runner must apply. This file is byte-identical to their concatenation
-- apart from the transaction wrapper described next, and it lives in
-- supabase/analysis/ (alongside the other run-by-hand SQL in this
-- project) DELIBERATELY: a file in supabase/migrations/ would be picked
-- up as a fourth migration and fail on a duplicate column the moment
-- anyone ran the CLI.
--
-- ONE TRANSACTION, NOT THREE. Each source file wraps itself in its own
-- begin;/commit;. Pasting all three verbatim would run three separate
-- transactions, so a failure in C would leave A and B applied - a
-- half-migrated database to reason about. Those three pairs are removed
-- here and replaced by the single begin;/commit; around everything
-- below, which is safe because PostgreSQL DDL is fully transactional:
-- either every statement lands or none does, and a failure rolls back to
-- exactly the state you started from. Nothing else is changed.
--
-- Do NOT add your own BEGIN/COMMIT around this paste.
--
-- ORDER IS MANDATORY, NOT COSMETIC. C's function bodies are
-- language sql, so PostgreSQL parses and validates them against the live
-- schema at CREATE time - they reference cls.probability and cls.is_won
-- (added by A) and l.expected_close_date (added by B), and would fail
-- outright if either were missing. A and B are independent of each
-- other; both must precede C.
--
-- RUN THIS BEFORE DEPLOYING THE APPLICATION CODE. The Forecast page
-- fails closed to zeros if these functions are absent, but the lead
-- create/edit form writes expected_close_date and will error until B has
-- been applied.
--
-- AFTER RUNNING, SPOT-CHECK THIS FIRST: the Pipeline page's Win Rate and
-- Avg. Closed-Won Deal should be completely unchanged. A's is_won
-- backfill reproduces the old isWonStage() name-match rule exactly, so
-- any movement in those two numbers means something is wrong, not that
-- something improved.
-- =====================================================================

begin;


-- #####################################################################
-- MIGRATION A of 3 - 20260916120000_lead_stage_probability_and_outcome.sql
--
-- Adds: customer_lead_stages.probability + .is_won, their backfill and CHECKs,
--          and the create_customer_with_admin() reseed.
-- #####################################################################
-- ---------------------------------------------------------------------
-- Stage probability + closed-won/closed-lost outcome.
--
-- WHY NOW: the Forecast module needs two things this table has never
-- been able to answer.
--
--   1. "What is this stage worth, probabilistically?" — a weighted
--      forecast is deal_value x stage probability, and no probability
--      column existed.
--
--   2. "Is this closed stage a WIN or a LOSS?" — 20260907120000 added
--      is_closed and deliberately stopped there, with this exact note:
--        "Deliberately NO is_won/similar semantic flag - that's an
--         explicit decision to keep this table to exactly the columns
--         required right now; if a future KPI needs to distinguish a
--         closed-won stage from a closed-lost one, that's a separate,
--         later change."
--      Forecast is that KPI ("Closed-Won to Date", and excluding Lost
--      from every figure), so this is that separate, later change.
--
-- Until now, "which closed stage counts as won" was resolved by a NAME
-- comparison in application code (isWonStage() in
-- features/leads/lib/stage-colors.ts: is_closed AND
-- lower(btrim(stage)) = 'won'), used by the Pipeline page's Win Rate and
-- Avg. Closed-Won Deal KPIs and by the stage color system. That rule
-- cannot be pushed into a SQL GROUP BY without becoming a second,
-- drift-prone copy of itself, which is why the flag lands here instead.
--
-- NO EXISTING NUMBER MOVES. The is_won backfill below reproduces
-- isWonStage()'s current rule exactly, so every existing tenant's Win
-- Rate, Avg. Closed-Won Deal and stage colors are bit-for-bit
-- unchanged after this migration. Only the SOURCE of the answer moves:
-- from a name match in TypeScript to a real column, which an admin can
-- then correct for a renamed stage ("Closed Won", "Contract Signed")
-- that the name match always got wrong.
--
-- REUSED, NEVER RECREATED: public.customer_lead_stages itself, its RLS
-- policies, its indexes, set_updated_at(), and
-- protect_lead_stage_transition() are all untouched. is_closed keeps its
-- exact existing meaning (this lead is locked) — is_won is strictly
-- additional information ABOUT a closed stage, never a replacement for
-- it, and nothing about lead locking changes.
--
-- WHY TWO CHECK CONSTRAINTS AND NO TRIGGER: both rules only reference
-- columns of the same row, so a table-level CHECK expresses them
-- completely. "Won is fixed at 100%" and "Lost is not applicable" stop
-- being conventions the application is trusted to honour and become
-- things the database will not store otherwise.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. COLUMNS
-- ---------------------------------------------------------------------

alter table public.customer_lead_stages
  -- smallint, not numeric: a probability is a whole percentage point.
  -- Nothing in the forecast needs 45.5%, and an integer keeps the
  -- weighted-value arithmetic below exact rather than approximate.
  --
  -- DEFAULT 0 is deliberately the CONSERVATIVE default, not a neutral
  -- one. A stage created outside the Stage Settings form (a script, a
  -- future import) contributes nothing to the forecast until an admin
  -- sets its probability, and a 0% row is plainly visible in the
  -- Forecast by Stage table. The opposite default (50) would silently
  -- inflate a forecast with a number nobody chose, and an inflated
  -- forecast is invisible.
  add column probability smallint not null default 0,

  -- Only ever true for a stage that is ALSO is_closed (enforced below).
  -- A customer may have several closed stages; at most a subset of them
  -- are wins. There is deliberately no is_lost column: "closed and not
  -- won" IS lost, and a second boolean would let the two disagree.
  add column is_won boolean not null default false;

-- ---------------------------------------------------------------------
-- 2. BACKFILL — is_won first, because the probability backfill reads it
-- ---------------------------------------------------------------------

-- EXACTLY isWonStage()'s current rule, so nothing any tenant currently
-- sees changes. A closed stage renamed to anything other than "Won" is
-- left as a loss here, which is precisely what the application already
-- treats it as today — silently "fixing" those would move live Win Rate
-- numbers, which this migration explicitly refuses to do.
update public.customer_lead_stages
   set is_won = true
 where is_closed = true
   and lower(btrim(stage)) = 'won';

-- Probability. The four seeded open-stage defaults are recognised by
-- name; every other OPEN stage (renamed, reordered, or customer-added)
-- gets 0 for the same reason the column default is 0 — under-reporting
-- is visible and correctable, over-reporting is not. Won is pinned to
-- 100 and every other closed stage to 0, matching the CHECK added next.
update public.customer_lead_stages
   set probability = case
     when is_won    then 100
     when is_closed then 0
     else case lower(btrim(stage))
       when 'new'       then 10
       when 'contacted' then 25
       when 'qualified' then 45
       when 'proposal'  then 70
       else 0
     end
   end;

-- ---------------------------------------------------------------------
-- 3. CONSTRAINTS — added AFTER the backfill, so they validate the
--    corrected data rather than rejecting the pre-migration state
-- ---------------------------------------------------------------------

alter table public.customer_lead_stages
  -- A stage cannot be "won" without being closed. Winning a deal is a
  -- terminal outcome; an open stage that claims to be a win would make
  -- both the forecast (which excludes closed stages) and Closed-Won to
  -- Date (which counts them) wrong at the same time.
  add constraint customer_lead_stages_won_implies_closed
    check (is_won = false or is_closed = true),

  -- The whole probability rule in one expression, in priority order:
  --   won    -> exactly 100 ("Won fixed at 100%")
  --   closed -> exactly 0   ("Lost not applicable" — it will never close)
  --   open   -> anything 0..100, the admin's own choice
  add constraint customer_lead_stages_probability_matches_outcome
    check (case
      when is_won    then probability = 100
      when is_closed then probability = 0
      else probability between 0 and 100
    end);


-- ---------------------------------------------------------------------
-- 4. SEED THE NEW COLUMNS FOR EVERY FUTURE CUSTOMER
--
-- BARE CREATE OR REPLACE IS CORRECT HERE, and that is not incidental.
-- PostgreSQL identifies a function by name + input parameter TYPE LIST.
-- 20260908120000 had to DROP + CREATE because it was adding a 9th
-- parameter (p_name), which is a DIFFERENT signature and would have left
-- the 8-arg version behind as an overload. This migration changes only
-- the BODY: all 9 parameters, their types, their order and their
-- defaults are reproduced verbatim from 20260908120000, so CREATE OR
-- REPLACE genuinely replaces that function object in place.
--
-- Consequences of it being a true replace, all deliberate:
--   * No second overloaded function is created, so a caller supplying
--     4 named arguments (SetPasswordForm passes p_email, p_phone,
--     p_company_name, p_name) stays unambiguous instead of hitting a
--     "function is not unique" error at runtime.
--   * The existing GRANT survives — a replace keeps the object's
--     privileges, so no grant is reissued here. 20260908120000 had to
--     reissue it precisely because its DROP destroyed them.
--   * SECURITY DEFINER, search_path, and the returns type are restated
--     identically; CREATE OR REPLACE does not inherit them.
--
-- THE ONLY CHANGE IS THE customer_lead_stages INSERT, which now also
-- seeds probability and is_won. Every other statement in the body is
-- byte-for-byte the one already running in production.
-- ---------------------------------------------------------------------

create or replace function public.create_customer_with_admin(
  p_email text,
  p_phone text,
  p_company_name text default null,
  p_website text default null,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_name text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_admin_role_id uuid;
  v_customer public.customers;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.customer_users where user_id = v_user_id) then
    raise exception 'User already belongs to a customer';
  end if;

  select id into v_admin_role_id from public.roles where name = 'ADMIN';
  if v_admin_role_id is null then
    raise exception 'ADMIN role is not configured';
  end if;

  insert into public.customers (name, company_name, email, phone, created_by, website, address, city, state, country)
  values (p_name, p_company_name, p_email, p_phone, v_user_id, p_website, p_address, p_city, p_state, p_country)
  returning * into v_customer;

  insert into public.customer_users (customer_id, user_id, role_id, name, status)
  values (v_customer.id, v_user_id, v_admin_role_id, p_name, 'Active');

  -- CHANGED: probability + is_won added. The four open-stage values are
  -- the defaults the Forecast spec calls for (New 10, Contacted 25,
  -- Qualified 45, Proposal 70); Won is the one is_won stage at 100, and
  -- Lost is closed-not-won at 0. These satisfy both CHECK constraints
  -- added earlier in this migration by construction.
  insert into public.customer_lead_stages (customer_id, stage, display_order, status, is_closed, is_won, probability)
  values
    (v_customer.id, 'New',       1, 'Active', false, false, 10),
    (v_customer.id, 'Contacted', 2, 'Active', false, false, 25),
    (v_customer.id, 'Qualified', 3, 'Active', false, false, 45),
    (v_customer.id, 'Proposal',  4, 'Active', false, false, 70),
    (v_customer.id, 'Won',       5, 'Active', true,  true,  100),
    (v_customer.id, 'Lost',      6, 'Active', true,  false, 0);

  return v_customer;
end;
$$;


-- #####################################################################
-- MIGRATION B of 3 - 20260916130000_lead_expected_close_date.sql
--
-- Adds: leads.expected_close_date + its partial index.
-- #####################################################################
-- ---------------------------------------------------------------------
-- leads.expected_close_date — when a deal is FORECAST to close.
--
-- WHY A NEW COLUMN: leads already has closed_at, and it is the wrong
-- thing twice over. closed_at is trigger-computed by
-- protect_lead_stage_transition() at the instant a lead enters a closed
-- stage, it is server-owned and unsettable by a client, and it is NULL
-- for every open deal — so it records when something DID close, looking
-- backwards, while a forecast needs a human's estimate of when
-- something WILL close, looking forwards. The two never overlap: a deal
-- has one or the other, never both meaningfully.
--
--   * `date`, not `timestamptz` — the same reasoning already written for
--     tasks.due_date in 20260911120000: "a due date is a calendar date."
--     Nobody forecasts a deal closing at 14:30. A plain date also makes
--     the monthly GROUP BY in the forecast aggregates exact instead of
--     timezone-dependent at the value level.
--
--   * NULLABLE, and expected to be null often. Plenty of deals — every
--     brand-new lead, everything at the top of the funnel — genuinely
--     have no date yet. NULL means "not forecast", which is real
--     information and must not be collapsed into a fabricated date. The
--     consequence is deliberate and surfaced in the UI: an undated open
--     deal still counts toward Weighted Forecast and Best Case, but
--     cannot appear in the by-month chart, so the chart's bars do not
--     sum to the headline figure. The Forecast page states that
--     difference explicitly rather than hiding it.
--
--   * NO CHECK forbidding a past date. A date that has slipped is a real
--     and common state, and the most actionable thing a manager can see
--     — the forecast chart gives those their own leading "Overdue"
--     bucket rather than pretending they cannot exist.
--
-- NO TRIGGER AND NO RLS CHANGE. This is an ordinary editable field:
--   * The closed-lead lock already covers it — protect_lead_stage_
--     transition() rejects ANY update to a lead whose closed_at is set,
--     every column included, so a closed deal's forecast date is frozen
--     with everything else at no extra cost.
--   * Visibility is already correct — "hierarchy-aware lead visibility"
--     scopes whole ROWS, so a new column on leads inherits exactly the
--     right per-role visibility with no policy edit.
--   * Identity protection does not apply — unlike customer_id/owner_id,
--     this is a value a user is meant to revise as a deal progresses.
--
-- INDEX: partial (WHERE expected_close_date is not null) because the
-- null rows are exactly the ones no forecast query ever looks for, and
-- leading with customer_id matches how every leads query is scoped.
-- This is the index behind the by-month GROUP BY and the
-- "expected to close this month" filter.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------


alter table public.leads
  add column expected_close_date date;

create index leads_expected_close_date_idx
  on public.leads (customer_id, expected_close_date)
  where expected_close_date is not null;


-- #####################################################################
-- MIGRATION C of 3 - 20260916140000_forecast_aggregates.sql
--
-- Adds: the four SECURITY INVOKER forecast rollup functions.
-- #####################################################################
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


-- =====================================================================
-- END OF ALL THREE MIGRATIONS.
-- =====================================================================

commit;
