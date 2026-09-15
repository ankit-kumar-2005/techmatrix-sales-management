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

begin;

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

commit;
