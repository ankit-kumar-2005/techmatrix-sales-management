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

begin;

alter table public.leads
  add column expected_close_date date;

create index leads_expected_close_date_idx
  on public.leads (customer_id, expected_close_date)
  where expected_close_date is not null;

commit;
