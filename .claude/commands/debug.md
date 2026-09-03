---
description: Systematically debug an issue — root-cause first, smallest safe fix, confirm before applying
argument-hint: <description of the bug or error>
---

# Debug

Debug the issue below systematically. Do not jump straight to a fix.

Issue: $ARGUMENTS

Workflow:

1. **Reproduce the issue.** Understand the exact steps/inputs that trigger it. If you can't
   reproduce it directly, gather enough detail (error text, logs, affected route/component)
   to reason about it precisely rather than guessing.
2. **Read the error carefully.** The full message, stack trace, and any surrounding
   context — don't skim past details that narrow down the cause.
3. **Identify the affected area** — which layer (`app/`, `features/`, `services/`, database/
   RLS, Supabase client config) the issue actually lives in, per `CLAUDE.md` Section C.
4. **Inspect relevant code** in that area, and check `CLAUDE.md` and the relevant
   `.claude/skills/` for whether an established convention was violated (a common source of
   bugs in this project: wrong Supabase client used, `"use client"` boundary issues, RLS
   policy gaps, missing server-side validation).
5. **Determine root cause.** Not just where the symptom appears, but why — trace it back
   until the actual cause is clear, not just the first plausible-looking suspect.
6. **Explain the root cause** clearly before proposing a fix.
7. **Propose the smallest safe fix** — the minimal change that actually addresses the root
   cause, not a broad rewrite of the surrounding code.
8. **Apply the fix only after confirming the diagnosis and proposed fix** with the user (for
   anything beyond a trivial, obvious one-line correction).
9. **Verify the fix** — re-run the reproduction steps, relevant tests, or type check/lint as
   applicable to confirm the issue is actually resolved and nothing else broke.
10. **Explain what caused the issue and how to prevent it** — the mentor-style explanation
    per `CLAUDE.md` Section 6, so the underlying pattern is understood, not just this instance.

## Hard rules

- **Never blindly rewrite working code** while chasing a bug — if a fix seems to require
  touching a lot of unrelated code, stop and reconsider whether the root cause has actually
  been found.
- **Never make large unrelated changes while fixing a bug.** Scope the diff to the actual
  fix.
