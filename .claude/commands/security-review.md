---
description: Focused security review — auth, authorization, RLS, tenant isolation, secrets, and input handling
argument-hint: [file, directory, or area to review — defaults to current changes]
---

# Security Review

Perform a focused security review of the target below, independent of the general
`/review-code` command. Read `CLAUDE.md` Sections E, G, H, and P first, and
`.claude/skills/multi-tenant-security/` and `.claude/skills/supabase-enterprise/`.

Target: $ARGUMENTS

Review:

- **Authentication** — every protected operation actually verifies a valid, current session
  server-side; no operation trusts a client-asserted identity.
- **Authorization** — every privileged operation checks role and organization membership
  server-side (service layer and/or RLS), not only in UI conditionals; negative cases
  considered (what happens when a Salesperson attempts a Manager/Admin-only action).
- **RLS** — every table touched has policies, the policies are actually restrictive (not
  `USING (true)` placeholders), and they correctly scope by `organization_id` and role where
  relevant.
- **Tenant isolation** — trace every data-access path in scope and confirm Organization A
  cannot reach Organization B's data through it, per `CLAUDE.md` Section G.
- **Secrets** — specifically check for `SUPABASE_SERVICE_ROLE_KEY` or any other secret
  reachable from client code, client bundles, logs, or API responses; check that no secret
  has been placed in a `NEXT_PUBLIC_*` variable.
- **Environment variables** — correct client (`NEXT_PUBLIC_*` vs server-only) used for each
  value; nothing sensitive marked public.
- **API validation / input validation** — every external input (Route Handler, Server Action,
  webhook, CSV import) validated server-side with Zod before use; no trust placed in
  client-side validation alone.
- **Session security** — session/cookie handling goes through Supabase's supported
  server-side helpers, not custom cookie logic.
- **Sensitive logging** — no passwords, tokens, service-role keys, API secrets, or excessive
  personal information in logs, per `CLAUDE.md` Section P's "never log" list.

Pay special attention to any occurrence of `SUPABASE_SERVICE_ROLE_KEY` and any
`NEXT_PUBLIC_*` variable in the reviewed scope — trace where each is used and confirm it
never crosses the server/client boundary incorrectly.

## Output format

Report findings grouped by severity (CRITICAL / HIGH / MEDIUM / LOW), most severe first.
CRITICAL is reserved for anything that could leak another tenant's data, expose a secret, or
bypass authentication/authorization entirely. For each finding: location, the concrete attack
or leak scenario, and a suggested fix direction.

## Hard rule

**Do not modify code during this command unless the user explicitly asks you to apply
fixes.** This command reports; it doesn't repair.
