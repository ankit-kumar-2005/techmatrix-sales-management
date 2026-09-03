---
name: database-design
description: PostgreSQL schema design conventions for this project — relationships, normalization, indexes, constraints, foreign keys, UUIDs, timestamps, migrations, and query performance. Use whenever designing or reviewing tables, migrations, or queries.
---

# Database Design

This is the deep reference behind `CLAUDE.md` Section F. Read that section first for the
binding rules — this document explains the reasoning and gives concrete patterns. Schema work
happens in Phase 2/3 of this project (see `CLAUDE.md` Section 7) — this skill defines the
standard for when it does.

## Primary keys

Use `uuid` primary keys (`default gen_random_uuid()`) for anything referenced across systems,
exposed in URLs, or potentially synced to a future mobile client. Avoid serial/bigint IDs for
these — they leak sequence/enumeration information and are awkward for offline-first mobile
sync patterns later.

```sql
create table leads (
  id uuid primary key default gen_random_uuid(),
  ...
);
```

## Relationships and foreign keys

Model every relationship as a real foreign key — never comma-separated IDs, never an array
column standing in for what should be a join table.

```sql
create table leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  assigned_to uuid references profiles(id) on delete set null,
  ...
);
```

Choose `ON DELETE` behavior deliberately per relationship:

- `cascade` — child rows have no meaning without the parent (e.g., a lead's activity log
  entries when the lead itself is deleted).
- `restrict` (or no action) — deletion should be blocked while dependents exist (e.g., don't
  allow deleting an organization with active leads without an explicit archival step).
- `set null` — the relationship is optional and the child can outlive it (e.g., an assigned
  salesperson being removed shouldn't delete the lead).

## Constraints

- `not null` on every column that must always have a value — don't leave columns nullable by
  default "just in case."
- `check` constraints for invariants the database itself can guarantee, e.g.:
  ```sql
  status text not null check (status in ('new', 'qualified', 'won', 'lost')),
  amount numeric not null check (amount >= 0),
  ```
- `unique` (often composite) for natural uniqueness, e.g., one membership row per user per
  organization:
  ```sql
  unique (organization_id, user_id)
  ```

## Indexes

Index:

- Every foreign key column (Postgres does not do this automatically).
- Every column commonly used in `WHERE`/`ORDER BY` for this app's access patterns — notably
  `organization_id` on every tenant-owned table, and any Leads filter/sort columns (status,
  assigned_to, created_at).
- Every column an RLS policy filters on — an unindexed policy predicate becomes a full table
  scan on every single query against that table, tenant isolation or not.

```sql
create index leads_organization_id_idx on leads (organization_id);
create index leads_status_idx on leads (status);
```

## Timestamps

Every mutable business entity gets:

```sql
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
```

with `updated_at` maintained by a trigger, not by convention alone:

```sql
create trigger set_updated_at
  before update on leads
  for each row execute function moddatetime(updated_at);
```

(or an equivalent trigger function — the point is `updated_at` cannot silently go stale
because someone forgot to set it in application code.)

## Normalization and JSON

- Avoid duplicating a value across tables when a foreign key/join will do. Denormalize only
  for a specific, measured performance reason, and note why at the point of denormalization.
- Avoid JSONB for anything that will be filtered, sorted, joined, or constrained — model it as
  real columns/tables instead. JSONB is appropriate for genuinely schema-flexible data (e.g.,
  a per-automation config blob whose shape varies by automation type), not as a shortcut
  around designing a table.

## Migrations

- Every schema change is a Supabase CLI migration file under `supabase/migrations/`, committed
  to version control — never a manual change against a shared database.
- Migrations are additive and forward-moving; don't edit a migration that's already been
  applied anywhere shared — write a new one.
- After any schema change, regenerate the TypeScript DB types under `types/` so application
  code can't silently drift from the real schema.

## Query performance at scale

The Leads table is expected to grow to thousands of rows per organization. Design with that
in mind from the start:

- Every list query is paginated (cursor- or offset-based) at the database level — never
  "fetch all, slice in JS."
- Filtering and sorting happen in the query (`WHERE`/`ORDER BY`), backed by the indexes above
  — not client-side over an already-fetched dataset.
- Consider composite indexes for common combined filters (e.g.,
  `(organization_id, status, created_at)`) once real access patterns are known, rather than
  guessing prematurely.
