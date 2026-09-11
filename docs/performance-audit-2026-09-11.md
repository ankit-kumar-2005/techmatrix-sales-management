# Navigation Performance Audit

**Date:** 2026-09-11
**Scope:** Client-side navigation between the four authenticated modules — Pipeline (`/sales-management`), Contacts (`/contacts`), Tasks (`/tasks`), Catalog (`/catalog`).
**Reported symptom:** "The destination page sometimes takes noticeable time to appear."

## Methodology

Static inspection only: application source, route structure, `proxy.ts`, the Supabase data-access layer, client components, and the full `supabase/migrations/` history (RLS policies, functions, indexes).

**Not performed:** live query profiling, `EXPLAIN ANALYZE`, browser timing, Vercel function logs, or any load testing. Every claim below is therefore labelled with its evidence level, and no claim of measured improvement is made anywhere in this document.

**No code was changed by this audit.** It is diagnosis only.

## Evidence legend

This document's most important convention. Every finding carries one of:

| Label | Meaning |
|---|---|
| **Confirmed from code** | Directly readable in the source or migrations. Not an inference. |
| **Likely** | Strongly implied by code structure, but the magnitude depends on runtime data. |
| **Requires measurement** | Plausible and worth testing, but cannot be settled by reading code. |

Do not act on a **Requires measurement** item as if it were confirmed. Section 13 exists specifically to convert those into one of the other two categories.

## Code-state caveat

This audit reflects the codebase **after** the immediately-preceding task, which added:

- React `cache()` request-memoization in `lib/supabase/server.ts` and `features/customers/lib/get-current-membership.ts`, deduplicating the auth + membership lookups between `app/(app)/layout.tsx` and each `page.tsx`.
- A `NavigationProgress` top progress bar (`components/shared/navigation-progress.tsx`, mounted in `app/layout.tsx`).

Section 6 in particular describes the **post-change** state (2 auth round-trips per navigation, not the 3 that existed before). Reconcile against git history accordingly.

---

## 1. Executive Summary

Navigation feels slow for two structurally different reasons that compound.

**(a) Nothing appears until everything is ready.** There is not a single `loading.tsx` or `<Suspense>` boundary anywhere in the route tree. All four routes are fully dynamic (`ƒ` in the build output). From click until the last Supabase query resolves, Next.js has nothing to show — the previous page just sits there. *Confirmed from code.*

**(b) The awaited work is much larger than "10 paginated rows."** Pagination is genuinely server-side for Contacts, Tasks, and Catalog — but those pages also fetch unpaginated data *alongside* the paginated list, and every row touched is filtered by an RLS policy that calls a **plpgsql function containing a recursive CTE, evaluated per row, for every non-ADMIN user**.

The single most important finding: `is_customer_user_visible()` is `plpgsql` (not inlinable), `STABLE`, and is called with a **per-row column argument** (`owner_id` / `assigned_to`) in the SELECT policies of `leads`, `contacts`, and `tasks`. For an ADMIN it short-circuits immediately. For everyone else it walks a `WITH RECURSIVE` descendant tree over `customer_users` **once per candidate row**.

Combined with `select("*")` over *all* leads on three of four pages, and `count: "exact"` on the paginated queries (which evaluates the policy across the whole matching set, not just the 10 rows returned), this is where server time most plausibly goes.

---

## 2. Navigation Flow

Traced flow for **Pipeline → Contacts**:

```
User clicks sidebar <Link href="/contacts">      (next/link, prefetch left at default)
        ↓
Client router requests the RSC payload for /contacts
        ↓
proxy.ts matcher matches
  (excludes only _next/static, _next/image, icon.png, image extensions)
        ↓
updateSession() → await supabase.auth.getUser()   ← NETWORK round-trip #1 to Supabase Auth
        ↓                                            must finish before rendering starts
app/(app)/layout.tsx
   getAuthenticatedUser(supabase)                 ← NETWORK round-trip #2 to Supabase Auth
   getCurrentMembership(supabase, user.id)        ← DB: customer_users + customers + roles
   membership.status check → renders AppShell (client component, no fetching of its own)
        ↓
app/(app)/contacts/page.tsx
   getAuthenticatedUser / getCurrentMembership    ← deduped via React cache()
   await Promise.all([
       getContactsPage()          → 10 rows + count:"exact" over ALL matching contacts
       getLeadsForCustomer()      → select("*") on leads, NO range/limit — ENTIRE lead table
       getVisibleTeamDirectory()  → RPC with its own recursive CTE
       getDuplicateCandidates()   → select("*") on contacts, limit 300 — 300 FULL rows
       getDismissedDuplicatePairs()
   ])
        ↓
   findPossibleDuplicates()   ← SYNCHRONOUS Fuse.js, in the render path, blocking the response
        ↓
RSC payload serialized (every lead + derived duplicate pairs + 10 contacts)
        ↓
Client hydrates ContactsPageClient / ContactList (441 lines) + LeadSearchSelect
        ↓
Page visible
```

**Pipeline → Tasks** — same shape, but the page runs **three** `getTasksBucketPage` queries (overdue/today/upcoming), each with its own `count: "exact"`, plus `getLeadsForCustomer()` and `getVisibleTeamDirectory()`.

**Pipeline → Catalog** — by far the lightest: `getCatalogItemsPage` (6 rows + count) and `getDistinctCatalogCategories`. **No leads, no team directory, no Fuse.js**, and its RLS policy is the cheap `is_customer_member(customer_id)`.

**Contacts/Tasks/Catalog → Pipeline** — pays `getLeadsForCustomer()` (all leads, `select *`) + all stages + the team-directory RPC, then hydrates the 1,218-line `pipeline-view.tsx`.

> ### ⚑ Catalog is your control group
>
> Catalog is structurally ~3–5× lighter on the server than the other three: no leads fetch, no team-directory RPC, no Fuse.js, and a cheap RLS predicate.
>
> - If Catalog feels **just as slow** → the cost is in the shared path (proxy auth hop, cold start, network/region).
> - If Catalog feels **noticeably snappier** → the cost is in the per-page queries (leads / team directory / counts / Fuse).
>
> This is the single cheapest measurement that splits the problem in half. Do it first.

---

## 3. Pagination Analysis

| Module | Pagination | Evidence |
|---|---|---|
| **Contacts** | **Server-side** ✅ — `.range(from,to)` + `count:"exact"` | `features/contacts/lib/get-contacts.ts:74` |
| **Tasks** | **Server-side** ✅ — `.range(from,to)` per bucket, 3 buckets parallel | `features/tasks/lib/get-tasks.ts:172` |
| **Catalog** | **Server-side** ✅ — `.range(from,to)` + `count:"exact"` | `features/catalog/lib/get-catalog-items.ts:85` |
| **Pipeline** | **CLIENT-SIDE** ❌ | `features/leads/components/pipeline-view.tsx:697-698` |

*All four rows: Confirmed from code.*

Pagination for Contacts/Tasks/Catalog is correctly implemented at the database level. Three things escape it:

**1. Pipeline is not server-paginated at all.** `useReactTable` uses `getPaginationRowModel()` + `getSortedRowModel()` with `data: leads`, no `manualPagination`, no `rowCount`/`pageCount` override. Every lead in the tenant is fetched, serialized into the RSC payload, sent over the wire, hydrated, then sliced 10-at-a-time in the browser. Sorting is also client-side over the full set.

**2. `getLeadsForCustomer()` is `select("*")` with no `.range()` or `.limit()` — and it runs on Pipeline *and* Contacts *and* Tasks.** On Contacts/Tasks it exists only to populate the Lead picker/filter (`LeadSearchSelect`, which documents that it filters in memory by design). Navigating to Contacts or Tasks pulls the entire lead table even though the page displays 10 contacts/tasks.

**3. `count: "exact"` is the expensive half of a paginated query.** Returning 10 rows is cheap; counting *all* matching rows requires evaluating the RLS predicate across the entire matching set. On Tasks this happens three times per page load.

Also unpaginated by design (both documented as deliberate in their source comments): `getDuplicateCandidates()` (300 full contact rows, every Contacts load) and `getDistinctCatalogCategories()` (every row's `category` column).

---

## 4. Supabase Query Analysis

| Query | Table | Selection | Bounded? | RLS predicate cost |
|---|---|---|---|---|
| `getLeadsForCustomer` | `leads` | `*` | ❌ **unbounded** | `is_customer_admin()` **+** `is_customer_user_visible(owner_id)` per row |
| `getLeadStagesForCustomer` | `customer_lead_stages` | `*` | ❌ (small table) | `is_customer_member()` — cheap |
| `getVisibleTeamDirectory` | RPC | — | n/a | own recursive CTE inside |
| `getContactsPage` | `contacts` | `*` + `count:exact` | ✅ rows / ❌ count | `is_customer_user_visible(owner_id)` per row |
| `getDuplicateCandidates` | `contacts` | `*` | ⚠️ limit 300 | `is_customer_user_visible(owner_id)` × up to 300 |
| `getDismissedDuplicatePairs` | `contact_duplicate_dismissals` | 2 cols | ❌ | — |
| `getTasksBucketPage` ×3 | `tasks` | `*` + `count:exact` | ✅ rows / ❌ count | `is_customer_user_visible(assigned_to)` per row |
| `getCatalogItemsPage` | `customer_catalog_items` | `*` + `count:exact` | ✅ rows / ❌ count | `is_customer_member()` — cheap |
| `getDistinctCatalogCategories` | `customer_catalog_items` | `category` | ❌ | `is_customer_member()` — cheap |
| `getCurrentMembership` | `customer_users` + joins | `*, customer:customers(*), role:roles(name)` | ✅ `.limit(1)` | cheap |

**Every query uses `select("*")`** — no column projection anywhere. On `leads` (unbounded) this directly inflates both the Postgres→PostgREST transfer and the RSC payload shipped to the browser. *Confirmed from code.*

**Leftover debug code:** `features/tasks/lib/get-tasks.ts:174-190` logs every bucket query result to the server console. Gated on `NODE_ENV !== "production"`, so it should not run on Vercel production — but it fires 3× per Tasks load in development and will distort any local timing you take.

---

## 5. Query Waterfalls

**Within each page, the independent queries are already correctly parallelized.** All four pages use `Promise.all([...])`; Tasks even nests `Promise.all` for its three buckets. There is no naive `await A; await B; await C;` in any page. *Confirmed from code — this box is already ticked.*

The waterfalls that do exist are **across layers**, and are structural rather than sloppy:

```
proxy auth.getUser()          ← must complete before the route renders at all
        ↓
layout getUser + membership   ← membership needs user.id, genuinely sequential
        ↓
page  Promise.all([...])      ← needs membership.customer.id for every query
```

Minimum serial chain per navigation: **auth hop (proxy) → auth hop (render) → membership query → page queries.** Three sequential network legs before the first page query can start.

One genuine in-query waterfall: `features/tasks/lib/get-tasks.ts:158-169` — when a search term is present, it first queries `leads` for matching ids, then uses those ids in the tasks query. Sequential by necessity, and only on search, not on plain navigation.

The previous task's `cache()` change removed the layout↔page duplication *within the RSC render*. **It does not remove the proxy's separate `auth.getUser()`** — React's per-request cache does not span the middleware/proxy runtime and the render runtime. Those remain two distinct round-trips.

---

## 6. Authentication / Authorization Overhead

Per navigation, current state:

| Location | Call | Deduped? |
|---|---|---|
| `lib/supabase/proxy.ts:34` | `supabase.auth.getUser()` | ❌ separate runtime — **still its own network round-trip** |
| `app/(app)/layout.tsx:23` | `getAuthenticatedUser()` | ✅ shared with page via `cache()` |
| `app/(app)/layout.tsx:29` | `getCurrentMembership()` | ✅ shared with page via `cache()` |
| each `page.tsx` | same two | ✅ reuses layout's result |

**2 auth round-trips + 1 membership DB query per navigation**, down from 3 + 2 before the preceding task. The remaining duplicate (proxy vs. render) is structural, not a code smell — the proxy hop exists to refresh the session cookie, which a Server Component cannot do.

Separately, **role/hierarchy resolution is re-done inside the database on every query.** `is_customer_user_visible()` re-resolves the caller's `customer_users` row + role on *every invocation* (first statement of its body), and every invocation is per-row. A query returning 500 leads for a non-ADMIN re-resolves the caller's membership 500 times inside Postgres, on top of the recursive walk. `getVisibleTeamDirectory()` then does its own recursive walk again.

**No security check anywhere is redundant in a way that should be removed.** Both the layout and page guards are legitimate defense-in-depth, and RLS is the real boundary.

---

## 7. Next.js Analysis

*All Confirmed from code:*

- **Zero `loading.tsx` files** in the entire `app/` tree.
- **Zero `<Suspense>` boundaries** in any page or layout (the only one is in `app/layout.tsx`, wrapping the progress bar).
- **No `next/dynamic` / `React.lazy` anywhere** — `pipeline-view.tsx` (1,218 lines), `task-list.tsx` (935), `contact-list.tsx` (441), `catalog-items-grid.tsx` (266) all ship in their route's initial JS.
- No route segment config (`dynamic` / `revalidate` / `fetchCache` / `runtime`) anywhere; `next.config.ts` is empty.
- Sidebar uses `next/link` correctly; **prefetch never disabled** — no `prefetch={false}` anywhere.

The consequence usually missed: **because these routes are fully dynamic and have no `loading.tsx`, `<Link>` prefetching buys almost nothing.** App Router prefetch caches the static shell *up to the nearest loading boundary*; with no boundary and no static shell there is nothing to prefetch. Prefetching isn't broken — it has nothing to work with. And because the proxy matcher catches prefetch requests too, any prefetch that does fire still costs an auth round-trip.

**This is the #1 cause of *perceived* slowness.** `<Link>` navigation with no loading boundary means the browser shows the previous page, unchanged, with zero visual feedback, for the entire server render. (The `NavigationProgress` bar added in the preceding task now covers the "no feedback" half; it does not address the "no UI until everything resolves" half.)

---

## 8. TanStack Query Analysis

**TanStack Query is not installed.** `package.json` contains `@tanstack/react-table` only — a different library, used solely for the Pipeline list view's table/sorting/pagination. There is no query cache, no `staleTime`/`gcTime`, no `refetchOnWindowFocus` — nothing to misconfigure. *Confirmed from code.*

What exists instead: each list component holds `useState` seeded from server-rendered props and calls a Server Action (`getContactsPageAction`, `getTasksBucketPageAction`, `getCatalogItemsPageAction`) for subsequent page/filter changes. Each guards the initial render with an `isFirstRun` ref — `features/contacts/components/contact-list.tsx:161`, `features/tasks/components/task-list.tsx:649`, `features/catalog/components/catalog-items-grid.tsx:88` — so **there is no double-fetch on mount.** Server-rendered data is trusted for first paint. This part is correctly done.

The consequence for navigation: **there is no cross-navigation cache at all.** Pipeline → Contacts → Pipeline re-runs Pipeline's full server render (including all leads) from scratch every time. Next.js's own Router Cache would normally soften this, but for fully-dynamic routes with no loading boundary it holds little.

---

## 9. Vercel Analysis

None of this is confirmable from code alone — but the code determines what Vercel is made responsible for.

- **Every one of these routes is `ƒ` (server-rendered on demand).** Nothing static, nothing cached. Each navigation is a function invocation. *Confirmed from code.*
- **Cold starts** — plausible for the first navigation after idle; should not explain *repeated* slowness within an active session. The reported "sometimes takes noticeable time" is consistent with cold-start behaviour layered on top of a baseline cost. *Requires measurement.*
- **Region latency is a real suspect because of the query count.** Each page performs ~2 auth round-trips + 3–5 Supabase queries. If the Vercel function region and the Supabase project region differ, that RTT is paid **per query**, not once. Five queries at 80 ms cross-region RTT = 400 ms of pure network before any Postgres work. *Requires measurement.*
- **The proxy runs on every matched request**, including RSC and prefetch requests, and makes a network call to Supabase Auth. No `runtime` is specified in `proxy.ts`, so it uses the platform default — worth confirming which, since an edge PoP far from the Supabase region makes that first hop disproportionately expensive. *Requires measurement.*

**Code-related vs. infrastructure causes separate cleanly here.** Unbounded lead fetches, per-row recursive RLS, exact counts, Fuse.js in the render path, and missing loading boundaries are all code. Cold starts, function region, and Supabase region are infrastructure. Both are plausible; §13 tells you the split.

---

## 10. Database / RLS Analysis

The deepest finding, and confirmed from the migration SQL.

### `is_customer_user_visible()`

`supabase/migrations/20260906120000_lead_hierarchy_and_optional_fields.sql:141` — defined once, never redefined.

Markers: `language plpgsql`, `security definer`, `set search_path = public`, **`stable`** (not `IMMUTABLE`).

```sql
create or replace function public.is_customer_user_visible(target_customer_user_id uuid)
returns boolean language plpgsql security definer set search_path = public stable as $$
declare v_customer_id uuid; v_caller_cu_id uuid; v_role_name text;
begin
  if target_customer_user_id is null then return false; end if;

  select cu.customer_id, cu.id, r.name into v_customer_id, v_caller_cu_id, v_role_name
  from public.customer_users cu join public.roles r on r.id = cu.role_id
  where cu.user_id = auth.uid() and cu.status = 'Active';

  if v_customer_id is null then return false; end if;

  if not exists (select 1 from public.customer_users t
    where t.id = target_customer_user_id and t.customer_id = v_customer_id) then return false; end if;

  if v_role_name = 'ADMIN' then return true; end if;          -- ← ADMIN short-circuits here
  if target_customer_user_id = v_caller_cu_id then return true; end if;

  return exists (
    with recursive descendants as (
      select cu.id, cu.manager_id from public.customer_users cu
      where cu.id = v_caller_cu_id and cu.customer_id = v_customer_id
      union all
      select cu.id, cu.manager_id from public.customer_users cu
      join descendants d on cu.manager_id = d.id where cu.customer_id = v_customer_id)
    select 1 from descendants where id = target_customer_user_id);
end; $$;
```

Why this is expensive **per query**, not per session:

1. It is **plpgsql**, so Postgres treats it as an opaque black box — it cannot be inlined into the query plan (unlike `is_customer_member` / `is_customer_admin`, which are `language sql` and are at least inlining candidates).
2. It is called with a **per-row column argument** (`owner_id`, `assigned_to`). `STABLE` permits caching within a single statement *for identical arguments*, but the argument varies per row — so it re-executes for each distinct owner/assignee value encountered.
3. The recursive CTE has **no early exit** — `exists(WITH RECURSIVE … SELECT 1 … WHERE id = target)` builds the descendant set first, then filters.
4. **ADMINs skip steps 4–5 entirely.** Non-ADMINs pay the full walk.

Sibling functions with the same recursive CTE: `get_visible_team_directory()` (same file, `:209`; redefined in `20260909120000_team_directory_names.sql:107`) — `STABLE`, `SECURITY DEFINER`. Also `get_customer_team_directory()` — `STABLE`, `SECURITY DEFINER`, non-recursive.

### RLS SELECT predicates (verbatim)

| Table | SELECT `USING` |
|---|---|
| `leads` | `is_customer_admin(customer_id) or (owner_id is not null and is_customer_user_visible(owner_id))` — **two** function calls per row |
| `contacts` | `is_customer_user_visible(owner_id)` |
| `tasks` | `is_customer_user_visible(assigned_to)` |
| `customer_catalog_items` | `is_customer_member(customer_id)` — cheap, no recursion |

Supporting functions `is_customer_member(uuid)` and `is_customer_admin(uuid)` (`20260904140000_customers_and_customer_users.sql:212` and `:228`) are both `language sql`, `security definer`, `stable`. Note there is no table named `catalog_items` — it is `customer_catalog_items`. `current_customer_id()` does not exist anywhere in the migrations.

Multiply the predicates by what each page actually scans:

- **Pipeline (non-ADMIN):** unbounded `select("*")` on `leads` → the predicate runs across **every lead row in the tenant**.
- **Contacts (non-ADMIN):** `count:"exact"` → predicate across **all** contacts, plus 300 more rows for duplicate candidates.
- **Tasks (non-ADMIN):** three `count:"exact"` queries → predicate across all tasks, three times.

### Index inventory

Every single-column index you would expect **does exist**:

| Table | Indexes |
|---|---|
| `customer_users` | `(customer_id)`, `(user_id)`, `(role_id)`, `(manager_id)`, `(status)`; UNIQUE partial `(user_id) WHERE status='Active'`; UNIQUE `(customer_id,user_id)`, `(customer_id,id)` |
| `leads` | `(customer_id)`, `(owner_id)`, `(status)`, `(stage_id)`; UNIQUE `(customer_id,id)` |
| `contacts` | `(customer_id)`, `(lead_id)`, `(owner_id)`, `(email)`, `(phone)`, `(created_at)`; UNIQUE `(customer_id,id)` |
| `tasks` | `(customer_id)`, `(lead_id)`, `(assigned_to)`, `(due_date)`, `(status)` |
| `customer_catalog_items` | `(customer_id)`, `(status)` |
| `customers` | `(created_by)`, `(status)` |
| `customer_lead_stages` | `(customer_id)`, `(customer_id, display_order)`, `(status)`, UNIQUE `(customer_id, lower(btrim(stage)))`, UNIQUE `(customer_id,id)` |
| `roles` | PK + UNIQUE `(name)` |

**Absent — and absence is a finding:** no composite `leads(customer_id, owner_id)`, `leads(customer_id, status)`, `contacts(customer_id, owner_id)`, `tasks(customer_id, assigned_to)`, `tasks(assigned_to, status)`, `tasks(customer_id, due_date)`. Notably **no `leads(created_at)`** (contacts has one; leads does not). The only non-constraint composite in the entire schema is `customer_lead_stages(customer_id, display_order)`.

Index gaps are real but almost certainly **secondary** to the per-row function cost.

> **Requires measurement.** The structure guarantees per-row function invocation for non-ADMINs; the actual millisecond cost depends on tenant row counts and hierarchy depth, which cannot be read from code. `EXPLAIN (ANALYZE, BUFFERS)` is the only way to settle it.

---

## 11. Frontend Rendering Analysis

**Fuse.js runs on the server, in the render path.** `features/contacts/lib/duplicate-detection.ts:105` — the loop at `:131-149` iterates up to 300 candidate docs and runs a **full `fuse.search()` per doc** against a 300-doc, 5-key index. That is roughly 300 × 300 × 5 ≈ 450,000 weighted bitap comparisons per Contacts page load, executed **synchronously inside the Server Component** before the response can be sent. Pure serverless CPU time, on every navigation to Contacts. *Structure confirmed from code; ms cost requires measurement.*

**No code splitting.** `pipeline-view.tsx` at 1,218 lines plus `@tanstack/react-table` and `@dnd-kit/core` all land in the Pipeline route's initial bundle; nothing is `next/dynamic`'d. *Confirmed from code.*

**Large hydration payloads.** The full lead array is serialized into the RSC payload for Pipeline, Contacts, *and* Tasks. With `select("*")`, every column of every lead crosses the wire on all three. *Confirmed from code.*

The list components' `isFirstRun` guards are correct — no wasteful refetch-on-mount.

---

## 12. Ranked Root Causes

### HIGH PROBABILITY

#### 1. No `loading.tsx` / no Suspense → zero UI until all server work completes

- **What:** every route awaits its full data set before emitting any HTML; no streaming, no skeleton.
- **Where:** absence of `app/(app)/*/loading.tsx`; no `<Suspense>` in any page/layout.
- **Why it slows navigation:** perceived latency = total server time. Also renders `<Link>` prefetch nearly useless for these dynamic routes.
- **Affected:** all four modules.
- **Confidence:** **Confirmed from code.** Category: route navigation / server rendering latency.
- **Verify:** DevTools Network → compare the RSC request's TTFB against when content paints; they will be nearly identical.

#### 2. Per-row recursive-CTE RLS function for non-ADMIN users

- **What:** `is_customer_user_visible()` (plpgsql, non-inlinable, recursive CTE, no early exit) invoked per row in the SELECT policies of `leads`, `contacts`, `tasks`.
- **Where:** `supabase/migrations/20260906120000_lead_hierarchy_and_optional_fields.sql:141`; policies on all three tables.
- **Why:** query cost scales with rows *scanned*, and each scanned row can trigger a hierarchy walk. ADMINs short-circuit; everyone else does not.
- **Affected:** Pipeline, Contacts, Tasks (not Catalog — cheap `is_customer_member` predicate).
- **Confidence:** structure **Confirmed from code**; magnitude **Requires measurement**.
- **Verify:** log in as ADMIN vs. SALES_REP and compare navigation times. Then `EXPLAIN (ANALYZE, BUFFERS)` the leads/contacts/tasks selects as each role.

#### 3. Unbounded `getLeadsForCustomer()` running on three of four pages

- **What:** the entire lead table is fetched, RLS-filtered row-by-row, serialized into the RSC payload, and hydrated — on Pipeline (for the table) and on Contacts + Tasks (only to feed an in-memory Lead picker).
- **Where:** `features/leads/lib/get-leads.ts:10`; called from `app/(app)/sales-management/page.tsx:53`, `app/(app)/contacts/page.tsx:65`, `app/(app)/tasks/page.tsx:121`.
- **Why:** multiplies cause #2 by the tenant's full lead count, and inflates payload/hydration.
- **Affected:** Pipeline, Contacts, Tasks.
- **Confidence:** **Confirmed from code.** Category: Supabase query + database + payload.
- **Verify:** check the row count returned; measure the RSC response size in DevTools for `/contacts`.

### MEDIUM PROBABILITY

1. **`count: "exact"` on every paginated query (×3 on Tasks)** — returning 10 rows is cheap; counting all matching rows makes the RLS predicate run across the full set. `get-contacts.ts:55`, `get-tasks.ts:125`, `get-catalog-items.ts:74`. *Usage confirmed; cost requires `EXPLAIN ANALYZE`.* Category: database latency.

2. **Fuse.js duplicate detection blocking the Contacts render** — ~300 searches over a 300-doc × 5-key index, synchronously, every Contacts load (`duplicate-detection.ts:105`), plus the 300-row `select("*")` feeding it. *Structure confirmed; ms requires profiling.* Category: server CPU.

3. **Two separate auth round-trips per navigation (proxy + render), serialized ahead of all page queries** — `lib/supabase/proxy.ts:34` and the render-side `getAuthenticatedUser`. The proxy hop cannot be deduped by React `cache()` (different runtime). *Confirmed from code; per-hop latency requires measurement.* Category: network / auth.

4. **Vercel ↔ Supabase region mismatch amplifying a 5-query-per-page design** — cross-region RTT is paid per query. *Cannot be determined from code — requires checking Vercel function region vs. Supabase project region.* Category: infrastructure/network.

### LOW PROBABILITY

1. **Missing composite indexes** — `leads(customer_id, owner_id)`, `contacts(customer_id, owner_id)`, `tasks(customer_id, assigned_to)`, `tasks(customer_id, due_date)`, `leads(created_at)`. All single-column indexes exist, so this is refinement, not a gap. *Requires `EXPLAIN ANALYZE` to justify.* Category: database.

2. **No code splitting / large client bundles** — 1,218-line Pipeline view + table + dnd-kit in the initial chunk, nothing lazy-loaded. Affects first load of a route more than repeat navigation. Category: JS bundle loading.

3. **Serverless cold starts** — plausible for the first hit after idle; does not explain repeated slowness in an active session. Category: infrastructure.

4. **Leftover dev `console.log`** — `features/tasks/lib/get-tasks.ts:174-190`. Dev-only, but will distort local measurement. Category: measurement hygiene.

---

## 13. What to Measure Next

### Chrome DevTools → Network

Throttling off, "Disable cache" off. Navigate Pipeline → Contacts.

- [ ] Filter to the RSC request (`?_rsc=`). Record **TTFB** — this is total server time (proxy + layout + page + Fuse). This one number splits server-side from client-side immediately.
- [ ] Record the **transfer size** of that RSC response for `/contacts` and `/tasks` — shows how heavy the full-lead-array payload is.
- [ ] Compare TTFB across `/catalog` vs `/contacts` vs `/tasks` vs `/sales-management`. **The gap between Catalog and the others is the cost of per-page work; the Catalog baseline itself is the cost of the shared path.**
- [ ] Performance tab: record a navigation, check scripting/hydration time after the response lands.

### Vercel

- [ ] Function logs → **Duration** for each of the four routes; compare p50 vs p95 (p95 ≫ p50 suggests cold starts).
- [ ] Confirm the **function region**, and whether the proxy runs at the edge or in Node.
- [ ] Check whether slow navigations correlate with `initDuration` (cold start) entries.

### Supabase

- [ ] Dashboard → Database → **Query Performance** (`pg_stat_statements`): sort by total and mean exec time. Expect the `leads` select and the `count` queries near the top.
- [ ] As a **non-ADMIN** user: `EXPLAIN (ANALYZE, BUFFERS)` on the leads select, the contacts select-with-count, and one tasks bucket. Look for per-row function call counts and repeated `CTE Scan` nodes.
- [ ] Run the same three plans as an **ADMIN** — the delta is the recursive-CTE cost.
- [ ] Check the Supabase project **region** vs. the Vercel function region.

### Next.js (local)

- [ ] `next build` already reports each route as `ƒ`; also read **First Load JS** per route to size the bundle question.
- [ ] Temporarily `console.time` around the `Promise.all` and around `findPossibleDuplicates` to split query time from Fuse CPU time. (Remember `get-tasks.ts` already logs in dev and adds noise.)

---

## 14. Recommended Fix Order

Investigation order. **Nothing here is implemented.**

1. **Measure TTFB per route, with Catalog as the control.** This single measurement decides whether you are chasing per-page query cost or shared/infrastructure cost. Do it before anything else.
2. **Compare ADMIN vs non-ADMIN navigation.** Cheap, fast, and directly confirms or kills the highest-value database hypothesis.
3. **`EXPLAIN (ANALYZE, BUFFERS)` the three hot selects as a non-ADMIN.** Confirms the per-row function cost and reveals whether `count:"exact"` or the row fetch dominates.
4. **Check Vercel function region vs. Supabase region, and p50/p95 function duration.** Separates code cost from infrastructure cost definitively.
5. **Then fix, highest value first:**
   1. Add loading boundaries / Suspense — biggest perceived win, lowest risk, touches no data or security.
   2. Bound `getLeadsForCustomer`, or stop calling it on Contacts/Tasks.
   3. Restructure the RLS predicate so the hierarchy walk happens once per query rather than once per row.
   4. Revisit `count:"exact"` and the Fuse.js placement.
   5. Composite indexes.
   6. Code splitting.

> **Item 5.3 deserves its own dedicated, carefully-reviewed design task.** It touches tenant isolation, and the current policies are **correct** even though they may be slow. Correct-and-slow beats fast-and-leaky. Do not fold it into a general performance sweep.

---

## 15. Files That Would Need Changes Later

Listed for planning only — **nothing was modified by this audit.**

**Loading boundaries (lowest risk)**
New `app/(app)/sales-management/loading.tsx`, `app/(app)/contacts/loading.tsx`, `app/(app)/tasks/loading.tsx`, `app/(app)/catalog/loading.tsx`; possibly `<Suspense>` wrappers inside each `page.tsx`.

**Unbounded lead fetch**
`features/leads/lib/get-leads.ts`; call sites `app/(app)/sales-management/page.tsx`, `app/(app)/contacts/page.tsx`, `app/(app)/tasks/page.tsx`; consumer `features/leads/components/lead-search-select.tsx` (would need server-backed search instead of in-memory filtering); `features/leads/components/pipeline-view.tsx` (would need `manualPagination`).

**RLS / database**
A **new** migration under `supabase/migrations/` (never edit an applied one) touching `is_customer_user_visible()` and/or the `leads`/`contacts`/`tasks` SELECT policies, plus any composite indexes.

**Counts**
`features/contacts/lib/get-contacts.ts`, `features/tasks/lib/get-tasks.ts`, `features/catalog/lib/get-catalog-items.ts`.

**Duplicate detection**
`features/contacts/lib/duplicate-detection.ts`, `features/contacts/lib/get-contacts.ts` (`getDuplicateCandidates`), `app/(app)/contacts/page.tsx` (to move it out of the blocking render path).

**Auth hop**
`proxy.ts`, `lib/supabase/proxy.ts`.

**Bundles**
`features/leads/components/pipeline-view.tsx`, `features/tasks/components/task-list.tsx`.

**Cleanup**
`features/tasks/lib/get-tasks.ts:174-190` (leftover dev `console.log`).
