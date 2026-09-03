---
description: Review code for architecture, correctness, security, and maintainability — reports issues, does not fix them
argument-hint: [file, directory, or PR/diff to review — defaults to current changes]
---

# Review Code

Review the code described below (or, if nothing is specified, the current uncommitted
changes) against `CLAUDE.md` and this project's conventions.

Target: $ARGUMENTS

Read `CLAUDE.md` first, and load the relevant `.claude/skills/` for the areas the code
touches (e.g., `multi-tenant-security` for anything touching `organization_id` or
authorization, `nextjs-enterprise` for App Router code, `supabase-enterprise` for
Supabase-touching code).

Review across these dimensions:

- **Architecture** — right layer (`app/` vs `features/` vs `services/` vs `lib/` vs
  `components/`), per `CLAUDE.md` Section C; Route Handlers thin per Section I.
- **TypeScript** — per `CLAUDE.md` Section L: no unjustified `any`, boundaries typed,
  unnecessary assertions, type duplication.
- **Next.js** — Server/Client Component boundaries, secrets not reachable from client
  bundles, correct use of layouts/loading/error/not-found, per Section D.
- **React** — component structure, hooks usage, unnecessary re-renders, prop drilling that
  should be restructured.
- **Supabase** — correct client used (browser vs server vs service-role), no service-role
  key anywhere near client code, per Section E.
- **Security** — per Section P: injection vectors, XSS, secret handling, sensitive logging.
- **RLS** — every tenant-owned table touched has policies that actually hold; no query that
  bypasses RLS unintentionally.
- **Multi-tenancy** — `organization_id` correctly scoped everywhere it should be; no path by
  which one organization's data could leak to another, per Section G.
- **Performance** — unbounded queries, missing pagination on large datasets (notably Leads),
  missing indexes, unnecessary client-side data loading, per Section O.
- **Error handling** — consistent structure, correct status codes, no leaked internals, per
  Section K.
- **Accessibility** — semantic HTML, labeling, keyboard navigation on interactive components.
- **Testing** — whether the change has tests proportionate to its risk, per Section Q.
- **Maintainability** — unnecessary abstraction, dead code, consistency with existing
  patterns.

## Output format

Report findings grouped by severity, most severe first:

- **CRITICAL** — security/tenant-isolation/data-loss issues; must fix before merge
- **HIGH** — correctness bugs, missing authorization checks, significant architecture
  violations
- **MEDIUM** — performance issues, missing validation, maintainability problems
- **LOW** — style, minor consistency, nice-to-have improvements

For each finding: file/location, what's wrong, why it matters (concrete failure scenario
where relevant, especially for CRITICAL/HIGH), and a suggested fix direction.

## Hard rule

**Do not modify code during this command unless the user explicitly asks you to apply
fixes.** This command reports; it doesn't repair.
