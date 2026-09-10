-- Catalog pricing units: replace the original ('One-time', 'Per month',
-- 'Starting at') vocabulary with ('One-time', 'Monthly', 'Yearly').
--
-- Design notes:
--   * A CHECK constraint cannot be altered in place — Postgres requires
--     dropping the old one and adding a new one. The original constraint
--     was declared inline (no explicit CONSTRAINT name) inside
--     20260910120000's CREATE TABLE, so Postgres auto-named it
--     customer_catalog_items_pricing_unit_check (the standard
--     "<table>_<column>_check" pattern for an unnamed single-column
--     CHECK) — dropped by that name below, `if exists` as a safety net
--     in case it was ever named differently.
--   * BACKFILL BEFORE THE STRICTER CHECK: adding a CHECK constraint
--     validates every existing row immediately (this isn't a NOT VALID
--     constraint) — any row still holding an old value would make this
--     migration fail outright once the new CHECK is added. The UPDATE
--     below runs first and maps the old vocabulary onto the new one:
--       'Per month'   -> 'Monthly'   (direct equivalent)
--       'Starting at' -> 'One-time'  (an assumption, not an exact
--                          equivalent — "Starting at" described a
--                          starting price with no fixed cadence, which
--                          the new three-value vocabulary has no direct
--                          match for; 'One-time' was chosen as the
--                          least presumptive fallback. If real
--                          'Starting at' rows exist by the time this
--                          runs, re-review whether 'One-time' is
--                          actually the right landing value for them
--                          specifically, or whether they should be
--                          hand-corrected to 'Monthly'/'Yearly' instead
--                          before/after this migration applies.
--   * The application layer (types/catalog.ts's PRICING_UNITS,
--     features/catalog/schemas.ts's pricingUnitSchema) is updated in the
--     same change that introduces this migration — the database and the
--     app's own validation move together, not in two separate steps.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

update public.customer_catalog_items
set pricing_unit = 'Monthly'
where pricing_unit = 'Per month';

update public.customer_catalog_items
set pricing_unit = 'One-time'
where pricing_unit = 'Starting at';

alter table public.customer_catalog_items
  drop constraint if exists customer_catalog_items_pricing_unit_check;

alter table public.customer_catalog_items
  add constraint customer_catalog_items_pricing_unit_check
  check (pricing_unit in ('One-time', 'Monthly', 'Yearly'));

commit;
