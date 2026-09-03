---
description: Plan a feature before any implementation happens — produces a plan only, no code changes
argument-hint: <feature or requirement description>
---

# Plan Feature

You are planning the feature described below. **Do not modify any application code, database
schema, or configuration during this command.** This command produces a plan, nothing else.

Feature/requirement: $ARGUMENTS

Follow this process, in order:

1. **Understand the requirement.** Restate it in your own words. If anything is ambiguous or
   underspecified in a way that would change the design, ask before proceeding rather than
   guessing.
2. **Inspect the existing project.** Read the relevant parts of the current codebase —
   directory structure, related features already built, existing patterns for similar work.
   Don't plan in a vacuum.
3. **Read `CLAUDE.md`** at the project root and treat it as binding. Note which sections are
   most relevant to this feature (e.g., multi-tenant security, data fetching, validation) and
   check the current phase in [Section 7 — Phase-Based Development](../../CLAUDE.md) — do not
   plan work that belongs to a later phase than the project is currently in, unless explicitly
   told otherwise.
4. **Identify affected files** — which existing files will change, and which new files (and in
   which directory per `CLAUDE.md` Section C) will be created.
5. **Identify architecture changes** — new directories, new services, new component
   boundaries, any deviation from existing patterns and why it's justified.
6. **Identify database changes** — new/changed tables, columns, constraints, indexes,
   relationships. Reference `CLAUDE.md` Section F and the `database-design` skill.
7. **Identify API/backend changes** — new Route Handlers, Server Actions, or service
   functions, and how they fit the request flow in `CLAUDE.md` Section I.
8. **Identify authentication/authorization implications** — what roles can do what, what
   needs a session check, what needs an organization-membership check. Reference `CLAUDE.md`
   Section H.
9. **Identify RLS implications** — which tables need new/changed policies, and what tenant
   isolation guarantees must hold. Reference `CLAUDE.md` Section G and the
   `multi-tenant-security` skill — treat this as mandatory whenever the feature touches
   `organization_id`, roles, or any tenant-owned table.
10. **Identify validation requirements** — what Zod schemas are needed, shared between client
    and server per `CLAUDE.md` Section J.
11. **Identify testing requirements** — per `CLAUDE.md` Section Q, what level of testing this
    feature warrants (unit/service/API/RLS/E2E), proportionate to risk.
12. **Identify risks** — anything that could break tenant isolation, performance (unbounded
    queries on large tables), or existing functionality. Call out anything genuinely uncertain.
13. **Produce an implementation plan** — an ordered, concrete list of steps small enough to
    implement and review incrementally. Each step should say what changes, where, and why.

## Output

Present the plan clearly, organized under the headings above (condensed where a section has
nothing to add — e.g., "No database changes required" is a valid, complete answer for section
6 if true).

## Hard rules

- **Do not write or modify any code, migration, or configuration file during this command.**
  This is planning only.
- **Wait for explicit approval** of the plan before any implementation begins — do not
  proceed to `/implement-feature` on your own initiative.
- If the plan would require jumping ahead of the project's current phase (see `CLAUDE.md`
  Section 7), say so explicitly and ask before including that work in the plan.
