---
name: performance-and-security-standards
description: >
  Use this skill whenever writing or editing a Supabase/Postgres query in
  this codebase, adding a new route or page, adding a list/table view with
  pagination or counts, touching Row-Level Security policies or any
  SECURITY DEFINER function, adding or changing a database migration or
  index, adding any feature that computes aggregates/totals over a list,
  or adding any CPU-heavy computation (fuzzy matching, large in-memory
  comparisons, dedup, etc.) inside a page's server render. Also use before
  trusting any inherited audit finding, prior note, or assumption about
  this codebase's behavior — verify it against the current code first.
---

# Performance & Security Standards

This codebase went through a full performance/security remediation (the
`docs/performance-audit-2026-09-11.md` audit, followed by Phases 0–8 and
3b). Every rule below traces back to a real mistake made and fixed during
that work — not a generic best practice. Read this before touching
data-fetching, pagination, authorization, migrations, or indexes; it's
short enough to re-check mid-task, not just once at the start.

## 1. Known failure modes in this repo (don't repeat these)

- **`getLeadsForCustomer()`** ([features/leads/lib/get-leads.ts](../../../features/leads/lib/get-leads.ts))
  was `select("*")`, unbounded, reused across the Pipeline page for what
  we assumed was one purpose. When we actually traced it (Phase 3b), it
  fed the KPI cards, "Leads by stage," the sortable List table, the Board
  view's per-column counts/totals, drag-and-drop, and `EditLeadDialog`'s
  form defaults — four-plus distinct consumers, not one. → **Rule: never
  add a second consumer to an existing query without re-tracing every
  field it returns against every consumer, and never fetch a full table
  to serve a picker, a label, or a badge** (see `PipelineLead`,
  `ContactListItem`, `TaskListItem`, `CatalogItemListItem`,
  `LeadLabel` in [get-lead-labels.ts](../../../features/leads/lib/get-lead-labels.ts)
  for the pattern that replaced it — a `Pick<>` type narrow enough that
  `tsc` fails if a consumer needing a dropped column is missed).

- **No route had a `loading.tsx` or Suspense boundary** — every
  navigation showed a blank/frozen page until the slowest query on the
  destination resolved. Fixed in Phase 1 with
  `app/(app)/{sales-management,contacts,tasks,catalog}/loading.tsx` and
  `components/shared/skeleton.tsx`. → **Rule: every new route ships a
  loading state matching its real layout on the same change that creates
  the route.**

- **`is_customer_user_visible()`** ([supabase/migrations/20260906120000_lead_hierarchy_and_optional_fields.sql](../../../supabase/migrations/20260906120000_lead_hierarchy_and_optional_fields.sql)) —
  a `plpgsql`, recursive-CTE, per-row RLS check — went unmeasured against
  a real non-admin hierarchy for most of the project, because the only
  test account was ADMIN, which short-circuits past the recursive path
  entirely via `is_customer_admin()`. Every other role's real cost stayed
  invisible. → **Rule: any authorization logic keyed on role/hierarchy
  must be tested against at least one non-admin account with a real
  reporting structure before being considered done** (see
  `supabase/analysis/test-account-seed.sql` for the seed script built
  specifically to close this gap).

- **`count: "exact"`** was the default on every paginated list
  (`getContactsPage`, `getTasksBucketPage` ×3 buckets,
  `getCatalogItemsPage`) with no check on whether an exact total was
  needed or what it cost under RLS. → **Rule: state explicitly why an
  exact count is needed before using one; never substitute a
  planner-estimated count (`count: "estimated"`/`"planned"`) where RLS
  affects row visibility — it reads table-wide statistics with zero
  awareness of who's asking, so it will be wrong, not just imprecise,**
  and the app displays that number directly in the UI.

- **Duplicate-contact detection** (Fuse.js over up to 300 rows, in
  `features/contacts/lib/duplicate-detection.ts`) ran synchronously
  inside the Contacts page's server render, blocking every visit on it
  even though most visits have zero duplicates to show. Fixed in Phase 7
  by moving it into its own async Server Component
  ([duplicate-contacts-panel.tsx](../../../features/contacts/components/duplicate-contacts-panel.tsx))
  behind a `<Suspense>` boundary. → **Rule: CPU-heavy work never blocks a
  page's initial render — stream it in separately (Suspense) or run it on
  demand, whichever preserves the feature's existing discoverability**
  (we chose Suspense specifically because the panel was already ambient/
  always-shown, never a click-to-check tool — don't silently turn one
  into the other while "just" fixing performance).

- **Composite indexes** matching our actual query shapes
  (`leads(customer_id, owner_id)`, `contacts(customer_id, owner_id)`,
  `tasks(customer_id, assigned_to)`, `tasks(customer_id, due_date)`) were
  missing even though the single-column indexes they'd be built from
  existed. → **Rule: when writing a query that filters on more than one
  column together, check whether a composite index matching that exact
  shape exists — don't assume single-column indexes are enough.** (Also:
  an index on a column only used inside a non-sargable function call,
  like `is_customer_user_visible(owner_id)`, won't help the planner —
  see `supabase/analysis/phase5-index-explain-plans.sql` for why
  candidates 1–3 there are expected to show no benefit, structurally,
  before any measurement is even run.)

- **An inherited audit claim was nearly acted on unverified**: the
  original audit stated adding `leads(created_at)` would help Pipeline's
  ordering. Re-checking `get-leads.ts` during Phase 3/5 showed Pipeline
  actually orders by `updated_at`, and nothing in the codebase sorts or
  filters leads by `created_at` at all. → **Rule: re-verify any inherited
  finding against the current code (cite file/line) before building on
  it** — including findings in this very skill file; re-check them
  against current code before relying on them, since the codebase moves
  and a skill doesn't update itself.

- **Pipeline's client-side-paginated List view looked like an obvious
  server-pagination target** — until tracing showed its KPI cards,
  "Leads by stage," the Board view's per-column counts/totals (and which
  stages even get a column), the Source filter's own option list, and
  optimistic drag-and-drop all depend on the *complete* customer-visible
  lead set being in memory at once, not just the current page (Phase 10).
  Paginating the underlying fetch would have silently made every one of
  those wrong. → **Rule: before changing a data-fetching pattern, check
  what else on that page/view depends on the current shape of the data —
  a performance fix that breaks a feature isn't a fix.**

## 2. Standing rules for this codebase

- Never `select("*")` in a server query without a stated reason; project
  exactly the columns the destination UI consumes, using a `Pick<>` type
  (not a hand-written duplicate shape) so a missed consumer fails to
  typecheck instead of silently rendering `undefined`.
- Every list-returning query is bounded (`range`/`limit`) unless the UI
  structurally needs the complete set — state which UI need, explicitly,
  in the code comment (e.g. Pipeline's KPIs/Board totals needing the
  full set is a real, load-bearing reason; a picker or a badge needing
  it is not).
- Every new route gets a loading state / Suspense boundary from the
  start, matching the real layout it's replacing — not a generic spinner.
- Any hierarchy/recursive authorization check (anything shaped like
  `is_customer_user_visible()`) is designed with its per-row cost in
  mind up front, and tested against a real non-admin account with a
  real reporting chain before shipping — ADMIN's short-circuit hides the
  real cost entirely.
- Any change to an authorization-bearing function or RLS policy is its
  own isolated, reviewed change, with an explicit before/after
  equivalence check across every role this app has (ADMIN, MANAGER,
  SENIOR_SALES_REP, SALES_REP) — never bundled with unrelated changes.
- Know what an exact count costs under RLS before defaulting to one;
  never use an estimated/planner count where row-level security applies
  to the table being counted.
- CPU-heavy computation (fuzzy matching, large in-memory comparisons,
  dedup passes) never runs synchronously in a page's initial render.
- Composite indexes are added at the time a matching query is written,
  justified by an actual `EXPLAIN (ANALYZE, BUFFERS)` plan — not months
  later as a retrofit, and not for a column only reachable through a
  non-sargable function call.
- Any inherited audit, finding, or assumption — including the ones in
  this file — gets re-verified against the current code before being
  acted on.
- Measure before optimizing wherever measurement is possible (a real
  `EXPLAIN` plan, a real non-admin account, a real row count); say so
  explicitly when it isn't possible in the current environment, rather
  than assuming or guessing at a number.
- Never bypass, weaken, or move RLS/authorization logic into the
  frontend to make something faster — performance work stays underneath
  the same authorization guarantees, never around them.

## 3. Pre-flight checklist

Run through before finishing any task that touches data-fetching,
pagination, authorization, or migrations:

1. Does every new/changed query project only the columns its
   consumer(s) actually read — traced, not assumed?
2. Is every list-returning query bounded, or is there a stated,
   written-down reason the full set is genuinely needed?
3. If this adds a route, does it ship with a `loading.tsx` or Suspense
   boundary matching its real layout?
4. If this touches RLS or a `SECURITY DEFINER` function, is there a
   documented before/after equivalence check across all four roles?
5. If this adds a count or total, is it justified as exact — and if RLS
   applies to the table, has "what does exact cost here" actually been
   asked?
6. If this adds CPU-heavy computation, does it run outside the page's
   blocking initial render?
7. If this adds a list view, does anything on the same page (KPIs,
   totals, other views, filters) depend on holding the full result set
   in memory — and would this change break that?
8. Is every claim here backed by a measurement, an `EXPLAIN` plan, or a
   current code citation — not a guess or an inherited assumption?
