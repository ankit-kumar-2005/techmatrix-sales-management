---
description: Implement a feature that has already been planned and approved
argument-hint: <feature name or reference to the approved plan>
---

# Implement Feature

You are implementing an **already-approved** plan. If no plan has been discussed and approved
for this feature in this conversation, stop and run `/plan-feature` first instead of
improvising an implementation.

Feature: $ARGUMENTS

Follow this process:

1. **Read `CLAUDE.md`** at the project root before writing any code — it is binding for
   architecture, security, and style decisions made below.
2. **Inspect existing code** relevant to this feature — follow existing patterns and
   directory conventions (`CLAUDE.md` Section C) rather than introducing new ones without
   reason.
3. **Follow the approved plan.** If reality on the ground differs from the plan in a way that
   matters (a file doesn't exist where expected, an assumption was wrong), pause and confirm
   the adjustment rather than silently improvising a different design.
4. **Implement incrementally** — small, reviewable steps rather than one large sweeping
   change, matching the plan's step breakdown.
5. **Keep changes focused** — touch only what this feature requires.
6. **Avoid unrelated refactoring** — if you notice unrelated cleanup opportunities, mention
   them, don't fold them into this change.
7. **Follow Server/Client Component boundaries** per `CLAUDE.md` Section D — Server Components
   by default, `"use client"` only where truly needed, no server-only code reachable from
   client bundles.
8. **Apply validation** — Zod schemas per `CLAUDE.md` Section J, shared between client and
   server where applicable.
9. **Apply security rules** — per `CLAUDE.md` Section P: no secrets in client code, no
   injection vectors, no sensitive data logged, RLS considered for any table touched.
10. **Consider multi-tenant isolation** on every step that touches data access — per
    `CLAUDE.md` Section G and the `multi-tenant-security` skill. This is not optional even for
    small changes.
11. **Run appropriate checks/tests** — type check (`tsc`), lint, and any existing test suite
    relevant to the changed area; run new tests if the plan called for them.
12. **Explain what changed** — a clear summary of the files touched and why, in the mentor
    style described in `CLAUDE.md` Section 6 (what/why/where), sized to the change.

## Hard rules

- **Do not rewrite unrelated working code.** Minimal, targeted diffs.
- **Do not skip ahead of the approved plan's scope** — if something extra seems necessary,
  flag it and ask rather than expanding scope unilaterally.
- **Do not skip the phase boundaries** in `CLAUDE.md` Section 7 — if implementing this
  feature would require capabilities from a later phase (e.g., auth isn't connected yet but
  the feature needs it), stop and raise that rather than stubbing it in an ad hoc way.
