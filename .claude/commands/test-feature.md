---
description: Determine what tests a feature needs, across every relevant layer — implements tests only if explicitly asked
argument-hint: <feature or area to analyze>
---

# Test Feature

Analyze the feature/area below and determine what testing it needs, per `CLAUDE.md` Section Q
and the `testing` skill.

Feature/area: $ARGUMENTS

Read `CLAUDE.md` and `.claude/skills/testing/` first, then inspect the actual code for this
feature — its services, Route Handlers/Server Actions, components, and any tables/RLS
policies it touches.

Determine, with specifics (not generic categories):

- **Unit tests** — which pure functions (`utils/`, pure logic in `services/`) have behavior
  worth locking down.
- **Component tests** — which components have real logic/behavior (conditional rendering,
  interaction handling) worth testing, as opposed to purely presentational ones that don't.
- **Service tests** — which service functions need coverage, including their authorization
  branches (allowed vs. denied cases).
- **API tests** — which Route Handlers need coverage for success, validation-failure, and
  auth/authz-failure cases, with expected status codes.
- **Integration tests** — which cross-layer flows matter (e.g., create-lead through service +
  database) and are worth testing as a unit rather than only in pieces.
- **RLS tests** — for every tenant-owned table this feature touches, what negative case must
  be proven (Organization A cannot read/write Organization B's row).
- **E2E tests** — whether this feature is part of a critical user journey worth an end-to-end
  test, and if so, what the journey is.

For each item, state *why* it matters (what real failure it would catch), not just that the
category applies — skip categories that genuinely don't apply to this feature rather than
padding the list.

## Output

A concrete, prioritized test plan: what to test, at what layer, and why — ordered roughly by
risk (tenant-isolation and authorization gaps first).

## Hard rule

**Implement tests only when the user explicitly asks you to.** By default this command
produces a test plan, not test code.
