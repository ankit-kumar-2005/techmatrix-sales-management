---
description: Review database schema, relationships, constraints, indexes, RLS, and tenant isolation — reports issues, does not fix them
argument-hint: [migration file, table name, or area to review — defaults to all migrations]
---

# Review Database

Review the database design/migrations described below against `CLAUDE.md` Sections F and G
and the `database-design` and `multi-tenant-security` skills.

Target: $ARGUMENTS

Read `CLAUDE.md` first, then `.claude/skills/database-design/` and
`.claude/skills/multi-tenant-security/`, then inspect the relevant migration files under
`supabase/` (or wherever schema is currently defined).

Review:

- **Tables** — clear purpose, sensible naming, no obvious missing entities for the domain.
- **Relationships** — modeled with real foreign keys, correct cardinality (no comma-separated
  IDs, no arrays standing in for a real relationship).
- **Primary keys** — UUIDs used appropriately per `CLAUDE.md` Section F.
- **Foreign keys** — present wherever a relationship exists; `ON DELETE` behavior chosen
  deliberately, not defaulted.
- **Constraints** — `NOT NULL` where values are always required, `CHECK` constraints for
  invariants, `UNIQUE` where natural uniqueness exists.
- **Indexes** — present on foreign keys, on common filter/sort columns, and critically on
  every column an RLS policy filters on.
- **Naming** — consistent, descriptive column/table naming across the schema.
- **`organization_id`** — present on every tenant-owned table; correctly typed and
  foreign-keyed to the organizations table; indexed.
- **RLS** — every tenant-owned or role-sensitive table has policies for every operation it
  supports (`select`/`insert`/`update`/`delete` as applicable); policies actually reference
  the authenticated user's organization membership/role, not something spoofable.
- **Tenant isolation** — walk through: could a member of Organization A ever see or modify a
  row belonging to Organization B, through any policy, view, or function in scope? Treat this
  as the primary question of the review.
- **Migration quality** — migrations are additive/reversible where practical, don't manually
  edit history, follow a consistent naming/ordering convention.
- **Query performance** — any query patterns implied by the schema that would force a full
  table scan at scale (especially for Leads, which may grow to thousands of rows).

## Output format

Report findings grouped by severity (CRITICAL / HIGH / MEDIUM / LOW), most severe first —
tenant-isolation and data-integrity gaps are CRITICAL by default. For each: the table/policy/
column involved, what's wrong, the concrete risk, and a suggested fix direction.

## Hard rule

**Do not modify database code, schema, or migrations during this command unless the user
explicitly asks you to apply fixes.** This command reports; it doesn't repair.
