# Database ER Diagram

Reconstructed by reading all 21 files in `supabase/migrations/` in filename
order and applying each change in sequence, so what follows is the **current
cumulative state** of the schema — not any single migration's snapshot.

Three things that end-state reconstruction changes versus reading any one file:

- **`leads.stage` does not exist.** It was created as a `text` column with a
  six-value CHECK in `20260904140000`, then dropped in `20260907120000` and
  replaced by `leads.stage_id`, a foreign key into the new per-tenant
  `customer_lead_stages` table. Stage names became customer data.
- **`customer_user_invitations` was created twice.** `20260914120000` created
  it, `20260914160000` dropped it (table, triggers, indexes and functions), and
  `20260914170000` recreated it as one consolidated definition. Only the third
  one is real.
- **Two migrations change tables their filename doesn't mention.**
  `20260911120000_tasks.sql` also adds `leads_customer_id_key UNIQUE
  (customer_id, id)` to `leads`, and `20260912120000_catalog_pricing_units.sql`
  replaces the `pricing_unit` CHECK vocabulary on `customer_catalog_items`
  (`One-time / Per month / Starting at` became `One-time / Monthly / Yearly`)
  without adding any column at all.

```mermaid
erDiagram

    %% ===================================================================
    %% SUPABASE-MANAGED (external - NOT defined by these migrations,
    %% shown only because seven columns across five tables reference it)
    %% ===================================================================
    auth_users {
        uuid id PK "auth.users - managed by Supabase Auth"
    }

    %% ===================================================================
    %% GLOBAL / SHARED - no customer_id, identical for every tenant
    %% ===================================================================
    roles {
        uuid id PK "default gen_random_uuid()"
        text name UK "NOT NULL. ADMIN / MANAGER / SENIOR_SALES_REP / SALES_REP, seeded by migration"
        text status "NOT NULL default Active. CHECK in Active or Inactive"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    %% ===================================================================
    %% TENANT ROOT
    %% ===================================================================
    customers {
        uuid id PK "default gen_random_uuid()"
        text name "NULLABLE. Added 20260908120000. CHECK null or not blank"
        text company_name "NULLABLE"
        text email "NOT NULL. Immutable after insert via customers_prevent_email_change trigger"
        text phone "NOT NULL"
        text website "NULLABLE"
        text address "NULLABLE"
        text city "NULLABLE"
        text state "NULLABLE"
        text country "NULLABLE"
        uuid created_by FK "NOT NULL. auth.users ON DELETE RESTRICT. The Primary Admin"
        text status "NOT NULL default Active. CHECK in Active or Inactive"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    %% ===================================================================
    %% TENANT-SCOPED
    %% ===================================================================
    customer_users {
        uuid id PK "default gen_random_uuid()"
        uuid customer_id FK "NOT NULL. customers ON DELETE CASCADE"
        uuid user_id FK "NOT NULL. auth.users ON DELETE CASCADE"
        uuid role_id FK "NOT NULL. roles ON DELETE RESTRICT"
        uuid manager_id FK "NULLABLE. SELF-REFERENTIAL composite FK on customer_id plus manager_id. ON DELETE SET NULL. CHECK manager_id is null or not equal to id"
        text name "NULLABLE. Added 20260908120000. CHECK null or not blank"
        text status "NOT NULL default Active. CHECK in Active or Inactive"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    customer_lead_stages {
        uuid id PK "default gen_random_uuid()"
        uuid customer_id FK "NOT NULL. customers ON DELETE CASCADE"
        text stage "NOT NULL. CHECK not blank. UNIQUE per customer on lower btrim stage"
        integer display_order "NOT NULL. Drives the stage color palette app-side"
        smallint probability "NOT NULL default 0. Added 20260916120000. Whole percent 0 to 100"
        boolean is_closed "NOT NULL default false. The only thing that locks a lead"
        boolean is_won "NOT NULL default false. Added 20260916120000. CHECK is_won implies is_closed"
        text status "NOT NULL default Active. CHECK in Active or Inactive"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    leads {
        uuid id PK "default gen_random_uuid()"
        uuid customer_id FK "NOT NULL. customers ON DELETE CASCADE. UNIQUE on customer_id plus id, added by the tasks migration"
        text company "NULLABLE since 20260906120000, was NOT NULL"
        text contact_name "NOT NULL"
        text email "NULLABLE. Added 20260906120000"
        text phone "NULLABLE. Added 20260906120000"
        text whatsapp_phone "NULLABLE. Added 20260907120000"
        numeric deal_value "NULLABLE since 20260906120000. Precision 12 scale 2. CHECK greater or equal 0. NULL means not provided, distinct from zero"
        uuid stage_id FK "NOT NULL. Added 20260907120000. Composite FK on customer_id plus stage_id to customer_lead_stages ON DELETE RESTRICT"
        uuid owner_id FK "NULLABLE. Composite FK on customer_id plus owner_id to customer_users ON DELETE SET NULL"
        text source "NULLABLE. No CHECK - the picker list is app-side only"
        text next_step "NULLABLE"
        date expected_close_date "NULLABLE. Added 20260916130000. Forward-looking forecast estimate"
        timestamptz closed_at "NULLABLE. Added 20260907120000. Server-computed by trigger. Non-null means the lead is read-only"
        text status "NOT NULL default Active. CHECK in Active or Inactive"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    customer_catalog_items {
        uuid id PK "default gen_random_uuid()"
        uuid customer_id FK "NOT NULL. customers ON DELETE CASCADE"
        text name "NOT NULL. CHECK not blank"
        text category "NOT NULL. CHECK not blank"
        numeric price "NOT NULL. Precision 12 scale 2. CHECK greater or equal 0"
        text pricing_unit "NOT NULL. CHECK in One-time or Monthly or Yearly - vocabulary replaced by 20260912120000"
        text description "NULLABLE"
        text status "NOT NULL default Active. CHECK in Active or Inactive"
        uuid created_by FK "NULLABLE. auth.users ON DELETE SET NULL"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    tasks {
        uuid id PK "default gen_random_uuid()"
        uuid customer_id FK "NOT NULL. customers ON DELETE CASCADE. Immutable after insert"
        uuid lead_id FK "NOT NULL. Composite FK on customer_id plus lead_id to leads ON DELETE CASCADE. Immutable after insert"
        text subject "NOT NULL. CHECK not blank"
        text description "NULLABLE"
        text priority "NOT NULL default Medium. CHECK in Low or Medium or High"
        date due_date "NOT NULL"
        uuid assigned_to FK "NOT NULL. Composite FK on customer_id plus assigned_to to customer_users ON DELETE RESTRICT"
        text type "NOT NULL default Other. CHECK in Call or Meeting or Email or Other"
        text status "NOT NULL default Pending. CHECK in Pending or Completed"
        uuid created_by FK "NULLABLE. auth.users ON DELETE SET NULL"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    contacts {
        uuid id PK "default gen_random_uuid()"
        uuid customer_id FK "NOT NULL. customers ON DELETE CASCADE. UNIQUE on customer_id plus id. Immutable after insert"
        uuid lead_id FK "NOT NULL. Composite FK on customer_id plus lead_id to leads ON DELETE CASCADE. Immutable after insert"
        uuid owner_id FK "NOT NULL. Composite FK on customer_id plus owner_id to customer_users ON DELETE RESTRICT"
        text name "NOT NULL. CHECK not blank"
        text company "NULLABLE"
        text title "NULLABLE"
        text email "NULLABLE"
        text phone "NULLABLE"
        text_array tags "NOT NULL default empty array. Real Postgres type is text[]"
        uuid created_by FK "NULLABLE. auth.users ON DELETE SET NULL"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    contact_duplicate_dismissals {
        uuid id PK "default gen_random_uuid()"
        uuid customer_id FK "NOT NULL. customers ON DELETE CASCADE"
        uuid contact_id_a FK "NOT NULL. Composite FK on customer_id plus contact_id_a to contacts ON DELETE CASCADE"
        uuid contact_id_b FK "NOT NULL. Composite FK on customer_id plus contact_id_b to contacts ON DELETE CASCADE"
        uuid dismissed_by FK "NULLABLE. auth.users ON DELETE SET NULL"
        timestamptz created_at "NOT NULL default now(). NO updated_at column - this table is append-only"
    }

    customer_user_invitations {
        uuid id PK "default gen_random_uuid()"
        uuid customer_id FK "NOT NULL. customers ON DELETE CASCADE. Immutable after insert"
        text email "NOT NULL. CHECK not blank. Immutable after insert. UNIQUE per customer on lower btrim email WHERE status is PENDING"
        text full_name "NOT NULL. CHECK not blank"
        uuid role_id FK "NOT NULL. roles ON DELETE RESTRICT"
        uuid manager_id FK "NULLABLE. Composite FK on customer_id plus manager_id to customer_users ON DELETE SET NULL"
        uuid invited_by FK "NOT NULL. auth.users ON DELETE RESTRICT. Immutable after insert"
        text status "NOT NULL default PENDING. CHECK in PENDING or ACCEPTED or EXPIRED or CANCELLED"
        timestamptz invited_at "NOT NULL default now(). The original send"
        timestamptz last_sent_at "NOT NULL default now(). Moves forward on every resend"
        timestamptz accepted_at "NULLABLE. CHECK status is ACCEPTED exactly when this is not null"
        timestamptz expires_at "NOT NULL default now() plus 1 hour. CHECK expires_at after invited_at"
        uuid accepted_customer_user_id FK "NULLABLE. Composite FK on customer_id plus accepted_customer_user_id to customer_users ON DELETE SET NULL"
        timestamptz created_at "NOT NULL default now()"
        timestamptz updated_at "NOT NULL default now()"
    }

    %% ===================================================================
    %% RELATIONSHIPS
    %%
    %% Cardinality is read off the actual constraint, never guessed:
    %%   ||--o{  parent side is "exactly one"  = the child FK is NOT NULL
    %%   |o--o{  parent side is "zero or one"  = the child FK is NULLABLE
    %% No relationship here is one-to-one: none of the FK columns carries a
    %% UNIQUE constraint of its own. accepted_customer_user_id is logically
    %% one-per-membership but is NOT constrained that way, so it is drawn
    %% zero-or-more.
    %% ===================================================================

    auth_users ||--o{ customers : "created_by, RESTRICT"
    auth_users ||--o{ customer_users : "user_id, CASCADE"
    auth_users ||--o{ customer_user_invitations : "invited_by, RESTRICT"
    auth_users |o--o{ customer_catalog_items : "created_by, SET NULL"
    auth_users |o--o{ tasks : "created_by, SET NULL"
    auth_users |o--o{ contacts : "created_by, SET NULL"
    auth_users |o--o{ contact_duplicate_dismissals : "dismissed_by, SET NULL"

    roles ||--o{ customer_users : "role_id, RESTRICT"
    roles ||--o{ customer_user_invitations : "role_id, RESTRICT"

    customers ||--o{ customer_users : "customer_id, CASCADE"
    customers ||--o{ customer_lead_stages : "customer_id, CASCADE"
    customers ||--o{ leads : "customer_id, CASCADE"
    customers ||--o{ customer_catalog_items : "customer_id, CASCADE"
    customers ||--o{ tasks : "customer_id, CASCADE"
    customers ||--o{ contacts : "customer_id, CASCADE"
    customers ||--o{ contact_duplicate_dismissals : "customer_id, CASCADE"
    customers ||--o{ customer_user_invitations : "customer_id, CASCADE"

    customer_users |o--o{ customer_users : "manager_id SELF-REFERENTIAL, SET NULL"
    customer_users |o--o{ leads : "owner_id, SET NULL"
    customer_users ||--o{ tasks : "assigned_to, RESTRICT"
    customer_users ||--o{ contacts : "owner_id, RESTRICT"
    customer_users |o--o{ customer_user_invitations : "manager_id, SET NULL"
    customer_users |o--o{ customer_user_invitations : "accepted_customer_user_id, SET NULL"

    customer_lead_stages ||--o{ leads : "stage_id, RESTRICT"

    leads ||--o{ tasks : "lead_id, CASCADE"
    leads ||--o{ contacts : "lead_id, CASCADE"

    contacts ||--o{ contact_duplicate_dismissals : "contact_id_a, CASCADE"
    contacts ||--o{ contact_duplicate_dismissals : "contact_id_b, CASCADE"
```

## What each table is for

**`roles`** — The four job functions a person can hold inside an organization:
ADMIN, MANAGER, SENIOR_SALES_REP, SALES_REP. It is reference data seeded by
migration and never written by the application; there is no UI for editing it.
It exists as a table rather than an enum so a membership can point at a role by
id, and so a role could be retired (`status = 'Inactive'`) without rewriting
historical rows. Every tenant shares these same four rows.

**`customers`** — One row per organization using the product: the tenant root.
Everything else tenant-scoped hangs off its `id`. `created_by` records the
person who originally signed up ("Primary Admin"), which is a narrower concept
than the ADMIN role — some settings are gated on being that specific person.
Its `email` is deliberately frozen after insert by a trigger, because it is the
organization's identity rather than an editable contact detail.

**`customer_users`** — A person's *membership* in an organization: which
customer, which auth account, which role, and who they report to. This is the
table that makes the app multi-tenant rather than multi-user. It is also the
org chart: `manager_id` points back into this same table, and the recursive walk
over that column is what decides whose records you can see. A partial unique
index allows only one `status = 'Active'` membership per auth user, so a person
belongs to one organization at a time.

**`customer_lead_stages`** — Each organization's own sales pipeline stages.
Originally the stages were a fixed six-value CHECK on `leads.stage`; that was
replaced so an admin can rename, reorder, deactivate or add stages with no
migration. `is_closed` marks a terminal stage and is the *only* thing that locks
a lead; `is_won` distinguishes a terminal win from a terminal loss; and
`probability` is the weighting the revenue forecast multiplies deal values by.
Stages are deactivated, never deleted, so a historical lead's stage always
resolves.

**`leads`** — A deal in the pipeline, and the busiest table in the schema. It
carries the contact details, the money (`deal_value`), the current stage, the
owner, and two different dates that are easy to confuse:
`expected_close_date` is a human's forward-looking forecast, while `closed_at`
is written by a trigger the moment the lead enters a closed stage. A non-null
`closed_at` makes the entire row read-only — for every role, including ADMIN —
enforced by both a trigger and the UPDATE policy.

**`customer_catalog_items`** — The products and services an organization sells,
with a price and a billing cadence, so they can be referenced when quoting a
deal. Admin-managed; ordinary members can read but not write. Items are
deactivated rather than deleted.

**`tasks`** — Follow-up work attached to a specific lead and assigned to a
specific member: a call to make, a meeting to hold, an email to send. Both the
lead it belongs to and the organization it belongs to are frozen after insert
(reassigning the person is fine, moving the task to a different deal is not).
Tasks are completed, never deleted.

**`contacts`** — The people at the customer's customer: named individuals
attached to a lead, with their own title, email, phone and free-form tags.
Separate from `leads` because one deal commonly involves several humans.

**`contact_duplicate_dismissals`** — Purely a record of "we already looked at
this pair and they are not duplicates." The app detects likely-duplicate
contacts by similarity; this table remembers which suggested pairs a user waved
off, so the same suggestion stops resurfacing. Rows are stored with the two ids
in a fixed sorted order (`contact_id_a < contact_id_b`) so a pair can only ever
be recorded once regardless of which way round it was found. Append-only — it
has no `updated_at` and no UPDATE or DELETE grant.

**`customer_user_invitations`** — The "Add User" flow's record of a pending
invite: who was invited, to which organization, with which role and manager, by
whom, and when it expires. It is deliberately *not* a membership — a PENDING
invitation grants nothing and creates no `customer_users` row. The membership is
created only when the invited person sets a password and
`accept_customer_user_invitation()` runs, and `accepted_customer_user_id` then
links the invitation to the membership it produced. Invitations are history:
there is no DELETE grant, and a withdrawn one is marked CANCELLED.

## Tenant-scoped vs. global

**Global / shared — no `customer_id`:**

- **`roles`** — the only genuinely global table. RLS is enabled with a
  `using (true)` SELECT policy, so any authenticated user can read all four
  rows; there is no INSERT/UPDATE/DELETE grant at all, because it is
  migration-managed reference data. Nothing about it is per-tenant.
- **`auth.users`** — Supabase-managed, outside `public`, and not reachable by
  the `authenticated` role at all. This is why several functions are SECURITY
  DEFINER: reading an email or name off this table is impossible for a normal
  caller.
- **`storage.buckets` / `storage.objects`** — the `avatars` bucket added by
  `20260905170000`. Public read; writes are restricted to a folder named after
  the uploader's own `auth.uid()`. Not drawn above: no `public` table has a
  foreign key into storage, the link is a URL string only.

**Tenant root:** `customers` has no `customer_id` of its own — its `id` *is* the
tenant key. Its RLS is scoped by membership (`is_customer_member`), so it behaves
as tenant-scoped even though it carries no such column.

**Tenant-scoped — carry `customer_id`, RLS enabled, 8 tables:**
`customer_users`, `customer_lead_stages`, `leads`, `customer_catalog_items`,
`tasks`, `contacts`, `contact_duplicate_dismissals`,
`customer_user_invitations`.

Two patterns are worth knowing when reading those policies:

1. **Same-customer composite foreign keys.** Every cross-table reference
   includes `customer_id` in the FK itself — `leads(customer_id, stage_id) →
   customer_lead_stages(customer_id, id)`, and the same shape for
   `tasks.lead_id`, `tasks.assigned_to`, `contacts.lead_id`,
   `contacts.owner_id`, `customer_users.manager_id`, and both invitation
   references. This makes pointing at another tenant's row structurally
   impossible at the constraint level, not merely forbidden by policy.
2. **Two tiers of visibility.** Most tables are visible to any member of the
   organization (`is_customer_member`). `leads` and `tasks` are narrower:
   hierarchy-aware, so a non-ADMIN sees only their own records plus those of
   their recursive `manager_id` descendants. `customer_user_invitations` is
   narrower still — ADMIN-only, which is precisely why an invitee needs
   SECURITY DEFINER helpers to read their own invitation.

## Functions reference

Not part of the ER diagram — none of these are tables. The **Security** column
matters more than usual in this schema, because both modes are used
deliberately and for opposite reasons: DEFINER where the function must read
something RLS hides from the caller, INVOKER where the caller's own RLS *is* the
intended scoping.

### SECURITY DEFINER — bypasses RLS on purpose

| Function | Returns | Used by |
|---|---|---|
| `is_customer_member(uuid)` | `boolean` | The SELECT/INSERT policy predicate on `customers`, `customer_lead_stages`, `customer_catalog_items`, `contacts`, `contact_duplicate_dismissals`. Must be DEFINER or it would recurse into `customer_users`' own RLS. |
| `is_customer_admin(uuid)` | `boolean` | The admin-gated policies on `customers`, `customer_lead_stages`, `customer_catalog_items`, `customer_user_invitations`, and the ADMIN branch of `leads`/`tasks` visibility. |
| `is_customer_user_visible(uuid)` | `boolean` | The hierarchy branch of `leads` and `tasks` visibility — walks `customer_users.manager_id` recursively. The single definition of "whose records can I see". |
| `create_customer_with_admin(9 args)` | `public.customers` | Called once at signup by `SetPasswordForm`. Creates the `customers` row, the ADMIN `customer_users` row, and seeds the six default `customer_lead_stages` — atomically. Replaced three times; final body is in `20260916120000`. |
| `get_customer_team_directory()` | `table` | Reads `customer_users` joined to `auth.users` for email — the whole organization, ADMIN-facing. |
| `get_visible_team_directory()` | `table` | Same, but role-filtered to what the caller may see. Feeds every Owner/Assignee picker and the Forecast by Rep name lookup. |
| `auth_email_has_account(text)` | `boolean` | `LoginForm`, to tell "wrong password" from "no such account" without exposing `auth.users`. |
| `accept_customer_user_invitation(uuid)` | `uuid` | The invitee's side of Add User. Re-validates the invitation under a row lock and inserts the one `customer_users` row. DEFINER because `customer_users` has no INSERT policy or grant at all — this function is the only way a membership is ever created. |
| `get_pending_invitation_for_current_user()` | `uuid` | `/set-password` and `/accept-invitation`, to reroute an invited user out of normal signup. Takes no argument, so it can only answer about the caller. |
| `get_invitation_context(uuid)` | `table` | The invitation screen's "You're Invited" details. Graduated disclosure: full detail only when the caller's verified email matches. Final version in `20260915120000`. |
| `validate_customer_user_invitation()` | `trigger` | BEFORE INSERT/UPDATE on `customer_user_invitations` — checks the role is active, the manager is an active member, and the email isn't already a member. |

### SECURITY INVOKER — the caller's own RLS is the scoping

| Function | Returns | Used by |
|---|---|---|
| `get_forecast_summary()` | `table` (1 row) | Forecast page KPI cards. Weighted forecast, best case, closed-won, expected-this-month, and the undated-deal counter — one scan of `leads` with aggregate FILTER clauses. |
| `get_forecast_by_stage()` | `table` | Forecast by Stage. LEFT JOIN from `customer_lead_stages` so an empty stage still returns a row. |
| `get_forecast_by_owner()` | `table` | Forecast by Rep. `GROUP BY leads.owner_id`; a NULL owner row (unassigned deals) can only reach an ADMIN. |
| `get_forecast_by_month(integer)` | `table` | The forecast trend chart. Buckets by `expected_close_date` into OVERDUE / one row per month / LATER. |
| `set_updated_at()` | `trigger` | BEFORE UPDATE on `roles`, `customers`, `customer_users`, `leads`, `customer_lead_stages`, `customer_catalog_items`, `tasks`, `contacts`, `customer_user_invitations` — nine tables. Not on `contact_duplicate_dismissals`, which has no `updated_at`. |
| `prevent_customer_email_change()` | `trigger` | BEFORE UPDATE on `customers` — freezes `email`. |
| `protect_lead_owner_id_change()` | `trigger` | BEFORE UPDATE on `leads` — only an ADMIN may reassign `owner_id`. |
| `protect_lead_stage_transition()` | `trigger` | BEFORE INSERT/UPDATE on `leads`. Owns three rules together: the closed-lead lock, the target-stage-must-be-active check, and computing `closed_at` server-side. |
| `protect_task_identity_columns()` | `trigger` | BEFORE UPDATE on `tasks` — freezes `customer_id` and `lead_id`. |
| `protect_contact_identity_columns()` | `trigger` | BEFORE UPDATE on `contacts` — freezes `customer_id` and `lead_id`. |
| `protect_customer_user_invitation_identity_columns()` | `trigger` | BEFORE UPDATE on `customer_user_invitations` — freezes `customer_id`, `email` and `invited_by`. |

**Why the four forecast functions are INVOKER and this is the interesting
distinction:** every other non-trigger function above is DEFINER because it has
to read past RLS. The forecast rollups are the opposite case — `leads` already
carries exactly the policy a forecast needs, so running as the invoker means
`hierarchy-aware lead visibility` is evaluated *inside* the function body for
the real caller. An ADMIN aggregates the whole organization, a MANAGER their own
branch of the org chart, a SALES_REP only their own deals — with no role check
written anywhere in the function or the page. None of them takes a
`customer_id` argument, because there is nothing to pass and nothing to forge.

A DEFINER version would have had to re-implement the recursive hierarchy
predicate by hand, creating a second copy of the most security-critical rule in
the application. Note also that the trigger functions are INVOKER by default
rather than by decision — `protect_lead_stage_transition()` actually depends on
it, since its own `SELECT` against `customer_lead_stages` is what makes a
cross-tenant `stage_id` invisible to the lookup.

## Generated against

This diagram reflects the schema as of the last migration in
`supabase/migrations/`:

> **`20260916140000_forecast_aggregates.sql`**

21 migration files total, `20260904140000_customers_and_customer_users.sql`
through the above. If `supabase/migrations/` contains anything newer than
`20260916140000`, this document is stale.

Note that `20260916120000`, `20260916130000` and `20260916140000` (the Forecast
work) had **not yet been applied to the live database** when this was written —
they were still pending, with a combined single-paste copy at
`supabase/analysis/_forecast_combined.sql`. This diagram describes the schema
those migrations define, which is the end state of the files, not necessarily
what is deployed right now.

## Reconciliation

Counted with grep across the whole migrations directory and checked against what
is actually drawn above:

| Check | Migrations | Diagram | |
|---|---|---|---|
| `create table` statements | 11 | 10 entities | `customer_user_invitations` is created twice (`20260914120000`, then again in `20260914170000` after `20260914160000` drops it). 11 − 1 = 10. |
| `drop table` statements | 1 | — | The invitations drop above. |
| `add column` statements | 10 | 10 | leads ×5 (`email`, `phone`, `stage_id`, `whatsapp_phone`, `closed_at`, plus `expected_close_date` = 6 — see below), customers ×1 (`name`), customer_users ×1 (`name`), customer_lead_stages ×2 (`probability`, `is_won`). |
| `drop column` statements | 1 | — | `leads.stage`, dropped `20260907120000`. Correctly absent from the diagram. |
| `alter column` statements | 4 | reflected | `leads.company` lost NOT NULL; `leads.deal_value` lost NOT NULL and its default; `leads.stage_id` gained NOT NULL. All shown. |
| Total columns | 113 | 113 | Per-table: roles 5, customers 14, customer_users 9, customer_lead_stages 10, leads 17, customer_catalog_items 11, tasks 13, contacts 13, contact_duplicate_dismissals 6, customer_user_invitations 15. |
| Distinct functions | 22 | 22 | 11 DEFINER + 11 INVOKER. Several were replaced across migrations (`create_customer_with_admin` 4×, `get_invitation_context` 3×, the two team-directory functions 2× each); only final versions are listed. |

The `add column` row needs one clarification: there are 10 `add column`
*statements*, and they add 10 columns, but `leads` receives 6 of them across
four different migrations (`email` + `phone` together, `stage_id` alone,
`whatsapp_phone` + `closed_at` together, `expected_close_date` alone) — hence
`leads`' final 17 columns = 12 original − 1 dropped + 6 added.
