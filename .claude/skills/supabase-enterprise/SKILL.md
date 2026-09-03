---
name: supabase-enterprise
description: Supabase architecture conventions for this project — browser vs server clients, Auth, PostgreSQL, RLS, migrations, environment variables, and service-role security. Use whenever writing or reviewing anything that touches Supabase, auth, or the database.
---

# Supabase Enterprise

This is the deep reference behind `CLAUDE.md` Sections E and F. Read those first — this
document explains the reasoning and gives concrete patterns. Supabase is not connected yet in
this project (Phase 4); this skill defines the standard for when it is.

## The two clients (three, rarely)

**`lib/supabase/client.ts` — browser client.** Built with the anon/public key
(`NEXT_PUBLIC_SUPABASE_ANON_KEY`). Used only from Client Components and client-side hooks.
Every query made with this client is subject to RLS as the currently authenticated (or
anonymous) user — this client has no elevated privilege, by design.

**`lib/supabase/server.ts` — server client.** Reads the user's session from cookies (via
Supabase's SSR helpers) so queries run as that authenticated user, with RLS still applying.
Used from Server Components, Route Handlers, Server Actions, and the service layer. This is
the default server-side client — not a bypass of RLS, just the same per-user access from the
server.

**Service-role client — exceptional, not default.** Built with
`SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS entirely. Only for genuinely privileged
server-only operations where RLS cannot express the rule (e.g., a trusted background job
operating across organizations). Constructed only in clearly-named, server-only code, never
reused as a general "server client," and never the default choice when the regular server
client would do.

```ts
// lib/supabase/server.ts — sketch, not final
export function createServerSupabaseClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { /* SSR cookie adapter */ } },
  );
}
```

## Hard rules — repeat these on every review

- **`SUPABASE_SERVICE_ROLE_KEY` never reaches client code.** Not imported into a Client
  Component's module graph, not sent in an API response, not logged, not in a
  `NEXT_PUBLIC_*` variable.
- **`NEXT_PUBLIC_*` is public by definition** — it's inlined into the client bundle at build
  time. Only genuinely public values (Supabase URL, anon key) belong there. Any new
  environment variable should default to server-only unless there's a specific reason the
  browser needs it.
- **RLS is not optional "for now."** A table without RLS enabled, or with an overly permissive
  policy (`USING (true)`) as a placeholder, is a live vulnerability the moment real data lands
  in it — not a TODO to defer past the current phase.

## Supabase Auth

- Login/logout/session refresh go through Supabase Auth's supported flows — no parallel auth
  system.
- Server-side session reading uses Supabase's SSR cookie helpers so Server Components, Route
  Handlers, and Server Actions all see a consistent, current session.
- A session proves *who* the user is; it does not by itself prove *which organization* they're
  acting under or *what role* they hold there — those come from an organization-membership
  lookup (typically a `memberships`/`organization_users` table), checked per request. See the
  `multi-tenant-security` skill.

## RLS patterns

A typical tenant-owned table's policy shape (illustrative, not final — actual policies are
designed in Phase 9):

```sql
alter table leads enable row level security;

create policy "org members can select their org's leads"
  on leads for select
  using (
    organization_id in (
      select organization_id from organization_members
      where user_id = auth.uid()
    )
  );
```

- Every tenant-owned table gets RLS enabled and explicit policies for every operation it
  supports (`select`/`insert`/`update`/`delete` as applicable) — no table left with RLS
  enabled but no policies (which denies everything) or RLS disabled (which denies nothing).
- Role-sensitive rules (e.g., a Salesperson only seeing their own leads, a Manager seeing
  their team's) are expressed in the policy itself where possible, not left entirely to
  application code — RLS is the backstop that must hold even if a server-side check is
  missed.
- Index every column an RLS policy filters on (`organization_id`, membership lookups) — an
  unindexed policy condition becomes a full scan on every query.

## Migrations

- All schema changes are Supabase CLI migration files, committed to `supabase/migrations/`.
  No manual schema edits against any shared database.
- Migrations are additive and ordered; avoid editing a migration that's already been applied
  elsewhere — add a new one instead.
- Regenerate TypeScript DB types (`types/`) whenever the schema changes, so application code
  and the real schema never silently drift apart.

## Environment variables reference

| Variable | Client-safe? | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Public by design |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Public by design, protected by RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | **No — never** | Server-only, bypasses RLS |

Any new secret follows the `SUPABASE_SERVICE_ROLE_KEY` pattern by default (server-only)
unless there's a specific, stated reason it must be public.
