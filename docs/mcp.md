# AI Connections (MCP) — implementation, operations and honest limits

Written for: whoever deploys, operates, tests or extends this feature next —
including at 3am when something is wrong.

The product name always comes from `BRAND_NAME` in `lib/brand.ts` (currently
"Pipeway"); this document uses it for readability, the code never hardcodes
it.

> **Status (2026‑10‑10).** Fully implemented and verified **locally** — unit,
> real-PostgreSQL and HTTP tests, listed in
> [What is verified](#what-is-verified-and-what-is-not). The migrations
> `20261010120000_mcp_platform.sql` and
> `20261011120000_mcp_oauth_client_restrictions.sql` have **not** been applied
> to production.
> Nothing has been tested yet with a live OAuth-issued token or a real AI
> client. Every item marked **UNVERIFIED** must pass the
> [manual verification](#manual-verification-procedure) before this is called
> production-ready.

## Contents

1. [The one rule](#the-one-rule)
2. [Architecture](#architecture)
3. [Supported clients](#supported-clients)
4. [OAuth: discovery, authorization, consent](#oauth-discovery-authorization-consent)
5. [Connection lifecycle: connect, block, disconnect, reconnect](#connection-lifecycle)
6. [Company settings, per-tool controls, default-deny writes](#company-settings-and-per-tool-controls)
7. [Authorization model — every check, in order](#authorization-model)
8. [Company isolation, membership, roles and RLS](#company-isolation-membership-roles-and-rls)
9. [Tool catalog, filters and errors](#tool-catalog)
10. [Idempotent creates](#idempotent-creates)
11. [Audit logging, privacy and retention](#audit-logging-privacy-and-retention)
12. [Token validation and signing-key cache](#token-validation-and-signing-key-cache)
13. [Sign-out, password change, ban, expiry and revocation](#sign-out-password-change-ban-expiry-and-revocation)
14. [Direct Data API access by OAuth tokens](#direct-data-api-access-by-oauth-tokens)
15. [Data model](#data-model)
16. [Limits](#limits)
17. [Environment variables](#environment-variables)
18. [Setup and manual migration procedure](#setup-and-manual-migration-procedure)
19. [Administration (in the app)](#administration-in-the-app)
20. [Runbook](#runbook)
21. [Automated tests](#automated-tests)
22. [Manual verification procedure](#manual-verification-procedure)
23. [What is verified, and what is not](#what-is-verified-and-what-is-not)
24. [Known limitations](#known-limitations)
25. [Extending](#extending)

---

## The one rule

**An AI client gets exactly the signed-in person's access — never more.**

Every MCP request runs through Supabase with **that person's own OAuth access
token**. PostgREST executes it as `authenticated` with `auth.uid()` = the
person, so the same RLS policies, role hierarchy and company isolation that
protect the app protect MCP. The MCP layer only **adds** checks; it never
replaces the database's own enforcement.

- There is **no service-role key** anywhere in the runtime, and none may be
  added for this feature.
- There is no shared or privileged account, and no `SECURITY DEFINER` function
  that widens what the caller can see. The Automation engine's
  `get_automation_records` (worker token, no owner filtering) is not used.
- No arbitrary SQL can be sent: search tools accept only structured filters
  validated against fixed allowlists.
- Writes go through the **same domain services the app's own forms use**.
- There are no delete tools.

---

## Architecture

```
AI client ─(1) POST /api/mcp, no token ───────────────────▶ 401  WWW-Authenticate: Bearer resource_metadata="…"
   │
   ├─(2) GET /.well-known/oauth-protected-resource/api/mcp ─▶ { resource, authorization_servers: [Supabase Auth] }
   ├─(3) Supabase Auth OAuth 2.1: metadata, Dynamic Client Registration, /authorize (PKCE S256)
   │        └─▶ browser lands on /oauth/consent?authorization_id=…   (this app)
   │              sign in → checks → Allow → mcp_connections row → approveAuthorization → back to the client
   ├─(4) Supabase /oauth/token → access token (user JWT with client_id, session_id) + rotating refresh token
   └─(5) POST /api/mcp  Authorization: Bearer <token>   (one JSON-RPC message per request)
            │
            ├─ verify the token locally (signature via cached JWKS, issuer, expiry, role, client_id, audience)
            ├─ Supabase client built FROM THAT TOKEN (lib/supabase/bearer.ts)
            ├─ get_my_mcp_context(client_id) → session still alive? membership, role, company switches,
            │                                    tool overrides, person block, this connection's state
            ├─ tools/list  = registry ∩ enabled for the company ∩ (writes only with "Allow changes")
            └─ tools/call  → authorize → rate limit → validate input → idempotency → run as the person
                             → output allowlist → audit row → last-used
```

- **Transport:** Streamable HTTP, stateless, JSON responses, using
  `@modelcontextprotocol/sdk` **1.30.1** (pinned exact). No server-side MCP
  session exists, so nobody's access is cached between requests. `GET` and
  `DELETE` return 405 after the 401 discovery check. A standalone `tools/call`
  works without a prior `initialize` (verified in `server.test.ts`).
- **Per request**, the endpoint builds a fresh SDK server whose tool list is
  computed from that person's live context.

### Where the code lives

| Path | What |
|---|---|
| `app/api/mcp/route.ts` | The endpoint. Thin: verify → session → SDK server → respond. |
| `app/.well-known/oauth-protected-resource/[[...resource]]/route.ts` | RFC 9728 metadata, at the bare path and `/api/mcp`; 404 elsewhere. |
| `app/oauth/consent/page.tsx` | Consent screen (Supabase "Authorization Path"). |
| `app/(app)/settings/ai-connections/page.tsx` | Admin page. |
| `app/(app)/settings/my-ai-connections/page.tsx` | Every user's own connections. |
| `next.config.ts` | Anti-framing headers for `/oauth/*`. |
| `features/mcp/config/limits.ts` | **Every** numeric limit. |
| `features/mcp/config/clients.ts` | Redirect URIs the consent screen may approve. |
| `features/mcp/registry/` | The tool registry (`index.ts`), field/filter allowlists (`fields.ts`, `filters.ts`), tools (`tools/*.ts`). |
| `features/mcp/lib/verify-token.ts`, `jwks-cache.ts` | Token verification and the signing-key cache. |
| `features/mcp/lib/access.ts` | Access decisions (session, membership, switches, blocks, tools). |
| `features/mcp/lib/handle-call.ts`, `persistence.ts` | Call orchestration; audit, rate limit, idempotency, last-used. |
| `features/mcp/lib/consent.ts`, `consent-actions.ts` | Consent decisions and the Allow/Deny actions. |
| `features/mcp/actions.ts`, `lib/admin-data.ts`, `components/` | Settings pages. |
| `features/{leads,tasks,contacts}/lib/*-service.ts` | Shared domain write logic (Server Actions **and** MCP). |
| `lib/supabase/bearer.ts` | Supabase client from a bearer token. |
| `supabase/migrations/20261010120000_mcp_platform.sql` | Schema. |
| `supabase/migrations/20261011120000_mcp_oauth_client_restrictions.sql` | Restrictive RLS for OAuth-client tokens used directly against the Data API. |
| `supabase/analysis/mcp-activity-retention.sql` | Daily 90-day cleanup (manual, reviewed SQL; `pg_cron`). |
| `supabase/analysis/mcp-parity-gate.mjs` | The live parity test you run by hand. |

---

## Supported clients

| Client | Redirect URI (what the consent screen approves) | Status |
|---|---|---|
| claude.ai, Claude Desktop, Claude mobile | `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback` — both, per [Anthropic's connector docs](https://claude.com/docs/connectors/building/authentication) | Configured by default. **End to end UNVERIFIED.** |
| Claude Code | `http://localhost:<any port>/callback`, `http://127.0.0.1:<any port>/callback` (RFC 8252 loopback) | Configured by default. **End to end UNVERIFIED.** |
| ChatGPT | Per [OpenAI's docs](https://developers.openai.com/plugins/build/auth): `https://chatgpt.com/connector_platform_oauth_redirect` **only** if the authorization server advertises `authorization_response_iss_parameter_supported: true`. Supabase's metadata (checked 2026‑10‑10) does not, so ChatGPT uses a per-connector `https://chatgpt.com/connector/oauth/{callback_id}` that only its MCP server management page shows. | **Not configured.** Copy the exact URI from ChatGPT into `MCP_ADDITIONAL_REDIRECT_URIS`. |
| MCP Inspector, other MCP clients | From that client's own documentation | Not configured. Add the exact URI to `MCP_ADDITIONAL_REDIRECT_URIS`. |

Matching is exact (scheme, host, port, path; query and fragment ignored). Only
Claude Code's loopback redirect is port-agnostic, and only on path
`/callback`. Never add a wildcard. Clients must support remote MCP over
Streamable HTTP, OAuth 2.1 with PKCE S256, and Dynamic Client Registration
(Supabase does not advertise Client ID Metadata Documents, so Claude falls back
to DCR).

---

## OAuth: discovery, authorization, consent

**Discovery.** An unauthenticated request to `/api/mcp` gets `401` with
`WWW-Authenticate: Bearer resource_metadata="<APP_URL>/.well-known/oauth-protected-resource/api/mcp", scope="openid"`
(plus `error="invalid_token"` when a token was sent). The metadata names
Supabase Auth (`<SUPABASE_URL>/auth/v1`) as the **only** authorization server
— Claude uses the first entry and never falls back — and `resource` equals
`<APP_URL>/api/mcp` exactly.

**Authorization server.** Supabase Auth's OAuth 2.1 Server (public beta):
metadata, Dynamic Client Registration, `/authorize` (PKCE required; unknown
redirect URIs rejected), `/token` (authorization code and refresh token
grants). Verified live on 2026‑10‑10 for discovery, DCR, authorize and token
error handling.

**Consent** (`/oauth/consent`, decisions in `features/mcp/lib/consent.ts`):

1. Signed out → `/login?next=/oauth/consent?…`. Only `/oauth/consent` is an
   accepted return path (`safeNextPath`), so it is not an open redirect.
2. Checks, all against live data as the signed-in person: active membership;
   not blocked; the company has AI connections on; the redirect URI is on the
   allowlist; not an OAuth client this person already disconnected.
3. Shows: "*{client}* wants to access {brand} as *{name}* at *{company}*", the
   enabled capabilities in plain words, the real redirect host, and a warning
   for loopback (Claude Code) redirects. The client name is self-asserted at
   registration and is shown only for information.
4. **Allow** re-runs every check server-side, records the `mcp_connections`
   row as the person (under RLS), then calls `approveAuthorization`. **Deny**
   calls `denyAuthorization` and only redirects back to an allowlisted URI.
5. Never auto-approves. If Supabase already approved this client before (it
   returns only a `redirect_url`), the redirect is still checked against the
   allowlist and the person's access before the browser is sent anywhere.
6. Served with `X-Frame-Options: DENY` and
   `Content-Security-Policy: frame-ancestors 'none'` (`next.config.ts`, scoped
   to `/oauth` and `/oauth/*`), so no other site can frame the Allow button.

---

## Connection lifecycle

```
                 consent (Allow)                       Disconnect (person)
   (no row) ───────────────────────▶  active  ───────────────────────────▶  disconnected (final for this client)
                                         │                                        │
                                         │ admin Block (person-level)             │ reconnect = remove & re-add the
                                         ▼                                        │ connector → NEW OAuth client →
                                  refused on every call,                          │ consent → new active row
                                  no new connections; Unblock restores ◀──────────┘
```

| Action | Who | Effect | Enforced |
|---|---|---|---|
| **Connect** | the person | Consent records an `mcp_connections` row (person × OAuth client), then approves the grant. | Insert policy: own active membership, not blocked, `revoked_at` and `last_used_at` empty; `created_at` stamped by the database. |
| **Block** | an admin of the same company | A row in `mcp_user_blocks` for that **person** — possible **before their first connection**. Every MCP request refused; no new connection can be registered, whatever OAuth client is used. Normal app access unaffected. Admins cannot block themselves. | Admin-only RLS; composite foreign key (person must belong to that company); `blocked_by`/`created_at` stamped; checked on every request. |
| **Unblock** | an admin of the same company | Deletes the block row. | Admin-only RLS. |
| **Disconnect** | the person (Settings → My AI Connections) | Sets their row's `revoked_at` (refused on the next request, before the token expires), then revokes the Supabase grant so the app cannot refresh. | Trigger: `revoked_at` is owner-only and **one-way** — never cleared or moved, by anyone. A second row for the same (person, client) is impossible (unique). |
| **Reconnect** | the person | Remove and re-add the connector in the AI app: it registers a **new** OAuth client and goes through consent. If the app reuses the disconnected client, the consent screen explains this instead of approving. | As Connect. |

Per-person blocking (not per connection) is deliberate: Claude registers a new
OAuth client on every fresh connection, so a per-connection block could be
sidestepped by reconnecting. The one-way disconnect is deliberate too: a stolen
access token is a normal user JWT and could otherwise undo its own disconnect
through the database API.

---

## Company settings and per-tool controls

| Setting | Default | Who | Stored in |
|---|---|---|---|
| AI connections on/off | **off** | admins | `customer_mcp_settings.enabled` |
| Allow changes (writes) | **off** | admins | `customer_mcp_settings.allow_writes` |
| Per-tool switch | read tools **on**, write tools **off** (registry default) | admins | `customer_mcp_tools` (overrides only) |

- A write tool is callable only when **AI connections**, **Allow changes** and
  **that tool** are all on. A tool switch can never override "Allow changes".
- Tool availability is not authorization: even an enabled write tool runs
  through the domain service and RLS as the person, so a Sales Rep still cannot
  edit a lead they do not own.
- Tool names are validated against the code registry before being stored;
  unknown names are rejected, and unknown rows are ignored.
- Switching AI connections off refuses every call on the next request and
  empties tool lists.

---

## Authorization model

Every MCP request meets these checks in this order. Each is evaluated against
**live** data on every request.

1. **Token** (`verify-token.ts`) — see
   [Token validation](#token-validation-and-signing-key-cache).
2. **Session still alive** (`get_my_mcp_context` → `session_state`) — the
   token's `session_id` must still exist in `auth.sessions`, within its
   time-box, for a user who is not banned. Ended → HTTP `401 invalid_token`.
   Unverifiable → refused. See [Sign-out](#sign-out-password-change-ban-expiry-and-revocation).
3. **Live access** (`evaluateAccess`): active membership, person not blocked,
   company switch on, connection known (approved through the consent screen)
   and not disconnected.
4. **Tool availability** (`authorizeToolCall`), at call time — the client's
   cached tool list is never trusted.
5. **Rate limit** — `MCP_RATE_LIMIT_MAX_CALLS` per person per
   `MCP_RATE_LIMIT_WINDOW_SECONDS`, counted in Postgres from `mcp_audit_log`
   (fails closed if unreadable).
6. **Input** — the tool's Zod schema. Unknown keys (`customer_id`, `owner_id`,
   `role`, …) are **stripped and ignored**.
7. **Idempotency** for creates with a key — see [Idempotent creates](#idempotent-creates).
8. **Execution as the person** — reads with an extra `customer_id` filter
   (defense in depth over RLS); writes through the shared domain services, then
   RLS and database triggers decide. Timeout `MCP_TOOL_TIMEOUT_MS`.
9. **Output allowlist** — responses are built key by key from allowlists; a
   runtime net drops unlisted top-level keys and strips forbidden keys
   (tokens, secrets, `customer_id`, …) at any depth.
10. **Audit row** and last-used update.

Identity is never taken from the client. The person, company and role come
from the verified token and the database. The only "who" a tool accepts is
`assignee_id` on writes — a business field (who a record is assigned to),
authorized exactly as in the UI.

---

## Company isolation, membership, roles and RLS

- **Membership:** exactly one active membership per user
  (`customer_users_one_active_membership_per_user`), so there is no company to
  choose. An Inactive or deleted membership means no context and every call is
  refused.
- **Roles** come from the live membership on every request:

  | Role | Sees (RLS, `is_customer_user_visible`) | Edits leads |
  |---|---|---|
  | Admin | the whole company | any lead; may assign owners |
  | Manager | own records + everyone below them, any depth | own leads only |
  | Senior Sales Rep | own records + their reports | own leads only |
  | Sales Rep | own records | own leads only |

  Tasks follow the assignee and contacts the owner, with the same hierarchy
  rule. These are the app's existing policies; MCP adds none and removes none.
- **Isolation:** every row the MCP layer reads or writes is protected by RLS
  scoped to the caller's own company; reads also filter by the context's
  `customer_id`. A record in another company, or one hidden by the hierarchy,
  answers `not_found` — the same answer as a record that does not exist.
- **Writes** use `createLead`/`updateLead`, `createTask`/`updateTask`/
  `completeTask`, `createContact`/`updateContact` — the exact code the forms
  run (owner forcing, closed-lead lock, stage checks, messages), followed by
  the same automation triggers. `create_lead` also fires the same
  post-response automation drain the form fires.

---

## Tool catalog

| Tool | Kind | Default | Notes |
|---|---|---|---|
| `search_leads` | read | on | Structured filters; stage by **name**; `owned_by_me`. |
| `get_lead` | read | on | `include_related` adds visible tasks/contacts (≤ `MCP_MAX_RELATED_RECORDS`). |
| `search_tasks` | read | on | `assigned_to_me`; default sort due date. |
| `get_task` | read | on | |
| `search_contacts` | read | on | `owned_by_me`. |
| `get_contact` | read | on | |
| `get_pipeline_summary` | read | on | Forecast RPCs (SECURITY INVOKER) — per-person scope. |
| `create_lead` | write/create | off | Idempotent. Only admins may assign another owner. |
| `update_lead` | write/update | off | Partial update merged with the current row. |
| `create_task` | write/create | off | Idempotent. Defaults: priority Medium, type Other, assignee = caller. |
| `update_task` | write/update | off | |
| `complete_task` | write/update | off | |
| `create_contact` | write/create | off | Idempotent. Sales Reps always own what they create. |
| `update_contact` | write/update | off | |

- **Annotations:** reads `readOnlyHint: true`; writes `readOnlyHint: false`;
  updates `destructiveHint: true`. Every write description asks the client to
  confirm with the person first.
- **Output:** only columns the app's own pages already show; money as a number
  plus an INR string (e.g. `₹18,000`). Never `customer_id`, `created_by`,
  integration fields, tokens or secrets.
- **Filters:** `filters: [{ field, operator, value }]`, `sort`, `limit`
  (≤ `MCP_MAX_RESULTS_PER_CALL`). `field` must be on the object's allowlist
  (`registry/fields.ts`); `operator` ∈ `equals, not_equals, greater_than,
  less_than, contains, is_empty, in`, valid for the field's type; values are
  type-checked and reach PostgREST only as bound builder arguments. No `.or()`,
  no raw filter strings, no SQL. `contains` escapes `% _ \` and drops `*`;
  `in` refuses quotes and backslashes.
- **Errors** (never raw database text): `not_found` (identical for missing and
  hidden), `forbidden`, `invalid_input`, `tool_disabled`, `rate_limited`,
  `conflict`, `access_denied`, `timeout`, `internal_error`.

---

## Idempotent creates

`create_lead`, `create_task` and `create_contact` accept an **optional**
`idempotency_key` (8–128 characters of `A–Z a–z 0–9 _ . : -`).

| Situation | Behaviour |
|---|---|
| No key | Every call creates a new record. The server never invents a key — it cannot tell a retry from two genuinely identical requests. |
| First call with a key | Reserves the key (`pending`), creates the record, records its id (`succeeded`). |
| Same key again, after success | Returns `{ id, created: false, replayed: true }` — after re-reading that id **through RLS**. A reservation pointing at a record the caller cannot see answers `not_found`. |
| Same key, first attempt failed | The key is freed; the retry creates the record. |
| Same key while still `pending` (< 15 min) | `conflict`: "still being processed". |
| Same key `pending` for more than `MCP_IDEMPOTENCY_STALE_PENDING_MINUTES` (15) | `conflict`: the earlier request never finished, so it is unknown whether the record was created — search for it, and if absent use a **new** key. Never retried automatically. |
| A call timed out | Its key stays `pending` for the same reason (the write may still have landed). |
| Key used for another tool | `invalid_input`. |
| Key already used by someone else in the company | `invalid_input` ("already been used"). Keys are unique per company — use random keys. |

What the database guarantees: a reservation starts `pending` with no record;
the only transitions are pending→succeeded (the only moment a record id can be
set), pending→failed and failed→pending; a succeeded reservation never changes;
`created_at`/`updated_at` are stamped by the database. Because the server
writes with the person's own token, a person could mark **their own**
reservation succeeded — which is why replays are re-checked through RLS.

---

## Audit logging, privacy and retention

> **The audit log is an activity log, not authoritative security evidence.**
> Rows are written with the person's own OAuth token (there is deliberately no
> service-role key), so a person could also append rows **about themselves**
> through the database API. Nobody can write a row attributed to anyone else
> or to another company, and no row can be edited, deleted or back-dated.
> Treat it as tamper-evident for everyone except the actor, and use server
> logs (Vercel) alongside it for anything authoritative.

**Each `tools/call` writes one row** with:
- person, company, OAuth client id, tool name;
- status (`ok`/`denied`/`invalid`/`error`/`rate_limited`), error code,
  duration;
- record ids touched (≤ 100);
- the **names** of arguments sent — only the tool's own parameters plus
  identity-shaped names (`IDENTITY_ARGUMENT_NAMES`: `customer_id`, `owner_id`,
  `role`, …), so a client cannot smuggle text in through invented parameter
  names;
- a **SHA-256 hash** of the idempotency key, never the key.

**Never argument values.** Denials with a known person (company off, blocked,
disconnected, session unverified) are audited. A request with no active
membership, or whose session ended (answered with 401 before the JSON-RPC
message is read), writes no audit row.

**History survives deleting a person.** `customer_user_id` has no foreign key,
so deleting a membership or an auth user keeps their rows (shown as "Former
team member"). Deleting the whole company still removes them.

**Retention: 90 days** (`MCP_AUDIT_RETENTION_DAYS`). No app role can delete
audit rows, so cleanup is an operator task, run in the Supabase SQL editor as
the database owner (it deletes only expired MCP log rows):

```sql
delete from public.mcp_audit_log        where created_at < now() - interval '90 days';
delete from public.mcp_idempotency_keys where created_at < now() - interval '90 days';
```

**Daily cleanup (prepared, not scheduled):** `supabase/analysis/mcp-activity-retention.sql`
is reviewed SQL you run by hand. It checks `pg_cron` is available (Supabase:
Dashboard → Integrations → Cron), creates `public.purge_expired_mcp_activity(90)`
(deletes only those two tables' rows older than the retention period, refuses
anything under 30 days, not executable by app roles), and schedules it daily at
03:17 UTC as `mcp-activity-retention`. Verified locally: correct rows only, a
second run deletes nothing, and ~225k expired rows out of 900k are removed in
about 0.2 s with the existing indexes, so no `created_at` index is added.
Rollback: `select cron.unschedule('mcp-activity-retention');` and drop the
function. Without `pg_cron`, run `select * from public.purge_expired_mcp_activity(90);`
monthly — retention then depends on someone remembering.

---

## Token validation and signing-key cache

A bearer token is accepted only when **all** of these hold (`verify-token.ts`):

1. `Authorization: Bearer <jwt>`, three base64url parts.
2. Header `alg` is `ES256` or `RS256` with a `kid`. HS256, `alg: none` and
   kid-less tokens are refused before any verification.
3. The `kid` names a key in the project JWKS (see cache below) of the matching
   type (ES256 ↔ EC P-256, RS256 ↔ RSA).
4. Signature and expiry verified against **exactly that key** by supabase-js
   `getClaims(token, { jwks })` — which therefore never downloads keys itself.
5. `iss` = `<SUPABASE_URL>/auth/v1`; `role` = `authenticated`; not anonymous;
   `sub` is a uuid.
6. **`client_id` present** — ordinary browser session tokens have none and are
   refused, so only OAuth-issued tokens reach MCP.
7. Every `aud` value is in `MCP_ALLOWED_AUDIENCES` (default `authenticated`
   plus `<APP_URL>/api/mcp`); a token minted for another resource server is
   refused.

Then the database confirms the token's **session** is still alive (next
section).

**Signing-key cache** (`lib/jwks-cache.ts`, one per server instance):
- downloaded from `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` (never from a
  URL in a token), with a 5 s timeout;
- refreshed every `MCP_JWKS_CACHE_TTL_SECONDS` (600);
- a token naming an unknown key id causes a download **only if no download was
  attempted** in the last `MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS` (60), across
  all requests — so random key ids cannot force a download per request, and a
  newly rotated key is picked up within that window;
- failed downloads back off; known keys keep verifying for at most
  `MCP_JWKS_MAX_STALE_SECONDS` (3600) after the last successful download, then
  every token is refused until a download works;
- only well-formed public signature keys are kept (no `enc` keys, no symmetric
  keys, never a private key); a document with more than `MCP_JWKS_MAX_KEYS` is
  rejected;
- a missing key or failed download always means **reject** — the cache only
  chooses which public key a signature is checked against.

---

## Sign-out, password change, ban, expiry and revocation

Supabase's own documentation states that access tokens of revoked sessions
"remain valid until their expiry time", and that the way to detect this is to
check that the token's `session_id` still exists in `auth.sessions`.
`get_my_mcp_context()` performs exactly that check — plus the session's
time-box (`not_after`) and an active ban (`auth.users.banned_until`) — inside
the one database call the MCP server already makes per request (no extra
network round trip, no dependency on the Auth API being reachable). It reports
`session_state`:

| `session_state` | Meaning | MCP response |
|---|---|---|
| `active` | the session row exists, within its time-box, user not banned | continue to the other checks |
| `ended` | session row gone (signed out), past `not_after`, or user banned | **HTTP 401 `invalid_token`** — the client refreshes, which fails for a deleted session, and re-authenticates |
| `missing_claim` | the token has no usable `session_id` | refused (`access_denied`, "could not confirm that your sign-in is still active") |
| `unknown` | the check could not be performed (e.g. a privilege problem reading `auth.sessions`) | refused the same way — fails closed; the consent screen and the rest of the app are unaffected |

| Event | Effect on MCP | Basis |
|---|---|---|
| Person signs out (global scope, the supabase-js default) | Refused on the next request, provided Supabase deleted the OAuth token's session | Supabase deletes the user's sessions on global sign-out (documented). That OAuth sessions are among them is **UNVERIFIED** — manual test 1 checks it. |
| Sign-out with local scope (one device) | Only that device's session ends; an OAuth session on another session row is unaffected | Supabase docs |
| Password change / reset | Refused on the next request **if** Supabase ended that session. Supabase documents password change as ending sessions without saying whether that includes every device. | **Not assumed; UNVERIFIED** |
| Supabase ban (`banned_until` in the future) | Refused on the next request | Checked directly |
| Session time-box (`not_after`) passed | Refused on the next request | Checked directly |
| Inactivity timeout | Enforced by Supabase at refresh time; the access token (≤ 1 h) is not refused early, because the session row is only cleaned up later | Supabase docs |
| Access token expiry | Refused (`401`) | Token validation |
| Person disconnects the app | Refused on the next request; grant revoked; final for that client | `revoked_at` |
| Admin blocks the person | Refused on the next request | `mcp_user_blocks` |
| Company switches AI connections off | Refused on the next request | settings |
| Membership deactivated or deleted | Refused on the next request (no context) | membership |
| Supabase grant revoked (any route) | Refresh fails; a still-valid access token keeps working at MCP until expiry unless the session also ended or the person disconnected through the app | Supabase |

**Outside MCP:** an OAuth access token is a normal user JWT. Used directly
against the Supabase Data API, it stays valid until it expires even after any
of the events above — see the next section.

---

## Direct Data API access by OAuth tokens

**An MCP OAuth access token is a user JWT.** Besides calling `/api/mcp`,
whoever holds it (the AI client) could send it, with the public publishable
key, straight to the Supabase Data API (PostgREST: `/rest/v1/…`, RPCs,
Storage). Such a request never passes through the MCP server, so **none of
the MCP-only controls apply to it**:

- the company switch and "Allow changes" as enforced by MCP;
- per-tool switches and input schemas;
- output allowlists;
- the MCP rate limit;
- MCP audit rows;
- the MCP session-liveness check (an OAuth token used directly stays valid
  until it expires, even after sign-out).

What does apply is everything the database enforces for that person: grants,
RLS (company isolation, role hierarchy), triggers — and the **OAuth-client
restrictions** in `supabase/migrations/20261011120000_mcp_oauth_client_restrictions.sql`.

### How OAuth-client requests are recognised

Supabase documents that OAuth access tokens carry a `client_id` claim, and
recommends `(auth.jwt() ->> 'client_id') is not null` in RLS to recognise them
([Token Security and RLS](https://supabase.com/docs/guides/auth/oauth-server/token-security)).
PostgREST verifies the JWT signature before exposing its claims, so the claim
cannot be forged or added. Ordinary app sessions have no `client_id` and are
unaffected. `public.mcp_request_is_oauth_client()` performs this test.

### The restrictions (33 additive `AS RESTRICTIVE` policies on 18 tables)

A restrictive policy is AND-ed with the existing permissive policies: it can
only remove access, and only from requests with a `client_id`. No existing
policy, grant, table or function is changed.

| Table | OAuth-client token, directly |
|---|---|
| `customer_mcp_settings`, `customer_mcp_tools` | insert/update **blocked** (cannot turn on "Allow changes" or enable tools) |
| `mcp_user_blocks` | insert/delete **blocked** (cannot block or unblock anyone) |
| `customer_integrations` | **read** and insert/update **blocked** (webhook credentials) |
| `customer_integration_participants` | insert/delete **blocked** |
| `customer_automations`, `customer_automation_versions` | insert/update **blocked** |
| `customer_user_invitations` | insert/update **blocked** |
| `customers` (company details) | update **blocked** |
| `customer_lead_stages`, `customer_catalog_items` | insert/update **blocked** |
| `meeting_notes`, `meeting_note_action_items` | insert/update **blocked** |
| `contact_duplicate_dismissals` | insert **blocked** |
| `mcp_connections` | insert **blocked** (only the consent screen creates connections); update allowed (MCP records last use) |
| `leads`, `tasks`, `contacts` | insert/update allowed **only when the company has AI connections on and "Allow changes" on** (`public.mcp_oauth_writes_allowed(customer_id)`); otherwise blocked |

**Still allowed for an OAuth-client token, directly:**
- **reads** of everything the person can read in the app, except
  `customer_integrations` — including leads, tasks, contacts, stages, catalog,
  meeting notes and, for admins, automations and invitations;
- with "Allow changes" on, **writes to leads, tasks and contacts** — limited
  by the person's normal RLS and triggers, but *not* by MCP tool switches or by
  which fields a tool would send;
- what the MCP server itself needs: `mcp_audit_log` insert,
  `mcp_idempotency_keys` insert/update, `mcp_connections` update;
- RPCs granted to `authenticated` (the forecast functions,
  `get_visible_team_directory`, `get_my_mcp_context`, …). The automation-worker
  and Lead Capture RPCs require their own secret tokens, and invitation
  acceptance/company creation require having no active membership, so they are
  not usable with an MCP token;
- **Storage** (avatar uploads) — not covered by these policies; low impact.

**Not affected:** `SECURITY DEFINER` functions owned by the table owner (the
automation worker, Lead Capture `ingest_lead`, the automation-event triggers
on leads/tasks/contacts, `get_my_mcp_context`) bypass RLS exactly as before —
none of these tables uses `FORCE ROW LEVEL SECURITY`. No delete is possible on
leads, tasks or contacts for anyone.

---

## Data model

`supabase/migrations/20261010120000_mcp_platform.sql` — one transaction,
additive only (no existing table, policy or function altered). The OAuth-client
restrictions are a second additive migration,
`20261011120000_mcp_oauth_client_restrictions.sql` (33 restrictive policies on
18 tables plus two helper functions — see the previous section).

| Table | Read | Write |
|---|---|---|
| `customer_mcp_settings` | admins of the company | admins |
| `customer_mcp_tools` | admins | admins |
| `mcp_user_blocks` | admins of the company | admins (insert = block, delete = unblock); `blocked_by`/`created_at` stamped |
| `mcp_connections` | the person; admins of the company | insert: the person (rules above); update: the person only, trigger-enforced; no delete |
| `mcp_audit_log` | the person; admins | insert only, as yourself, in your own company; no update/delete |
| `mcp_idempotency_keys` | the person | the person; pending-first, trigger-enforced transitions; no delete |

Functions — all `SECURITY DEFINER`, `search_path = public`, owned by the
migration owner, **not executable by anon**, and each answers only about the
caller:

| Function | Purpose |
|---|---|
| `get_my_mcp_context(p_oauth_client_id)` | Session state, membership, role, company switches, tool overrides, whether the caller is blocked, and the caller's own connection for that client. One call per MCP request. |
| `mcp_is_own_membership(customer_id, customer_user_id)` | Is this the caller's own active membership? False for anyone else's ids, whether or not they exist. Used by policies. |
| `mcp_caller_is_blocked()` | No argument — cannot be asked about anyone else. Used by the connection insert policy. |

Triggers stamp timestamps (`created_at`, `blocked_by`), protect identity
columns, keep `revoked_at` one-way, and enforce idempotency transitions. No
column holds a token, client secret or other auth material.

---

## Limits

All in `features/mcp/config/limits.ts`.

| Name | Value |
|---|---|
| `MCP_MAX_RESULTS_PER_CALL` / `MCP_DEFAULT_RESULTS_PER_CALL` | 50 / 20 |
| `MCP_MAX_FILTER_CONDITIONS` | 8 |
| `MCP_MAX_IN_VALUES` / `MCP_MAX_FILTER_TEXT_LENGTH` | 25 / 200 |
| `MCP_MAX_RELATED_RECORDS` | 25 |
| `MCP_RATE_LIMIT_MAX_CALLS` per `MCP_RATE_LIMIT_WINDOW_SECONDS` | 60 per 60 s |
| `MCP_TOOL_TIMEOUT_MS` (route `maxDuration` 30 s) | 20 000 |
| `MCP_MAX_REQUEST_BODY_BYTES` | 256 KiB |
| `MCP_AUDIT_RETENTION_DAYS` | 90 |
| `MCP_LAST_USED_TOUCH_INTERVAL_SECONDS` | 300 |
| `MCP_IDEMPOTENCY_KEY_MIN_LENGTH` / `_MAX_LENGTH` | 8 / 128 |
| `MCP_IDEMPOTENCY_STALE_PENDING_MINUTES` | 15 |
| `MCP_JWKS_CACHE_TTL_SECONDS` / `_UNKNOWN_KID_REFRESH_SECONDS` / `_MAX_STALE_SECONDS` | 600 / 60 / 3600 |
| `MCP_JWKS_MAX_KEYS` | 20 |
| `MCP_ADMIN_ACTIVITY_ROWS` | 25 |

---

## Environment variables

Placeholders only — never commit real values. No new secret is required, and a
service-role key must never be added for this feature.

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes (already set) | `https://<project-ref>.supabase.co` | Bearer client, token issuer, JWKS location. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes (already set) | `<publishable-key>` | Bearer client and signature verification. Public by design. |
| `APP_URL` | **yes** in production | `https://<your-production-domain>` | The MCP resource URL is `${APP_URL}/api/mcp` and must equal what people paste into the AI client. |
| `MCP_ALLOWED_AUDIENCES` | no | `authenticated,https://<your-production-domain>/api/mcp` | Override the accepted `aud` values (comma-separated). Default as shown. |
| `MCP_ADDITIONAL_REDIRECT_URIS` | no | `https://chatgpt.com/connector/oauth/<callback-id-from-chatgpt>` | Extra **exact** redirect URIs the consent screen may approve (comma-separated). |

---

## Setup and manual migration procedure

### 1. Supabase dashboard (one time)

1. **Authentication → OAuth Server:** enabled; **Authorization Path**
   `/oauth/consent`; **Allow Dynamic OAuth Apps** on. (Done 2026‑10‑10.)
   Record the page's beta notice and the project plan here — currently
   **UNVERIFIED**.
2. **Authentication → URL Configuration → Site URL:** the production URL. Do
   not change it for testing; it also drives password-reset and confirmation
   emails.
3. **Authentication → OAuth Apps:** delete `pipeway-gate-probe (safe to delete)`
   and any `pipeway-parity-gate (safe to delete)` clients left by tests.

### 2. Apply the migration (you, manually)

1. Back up or snapshot the database as you would for any migration.
2. Open the Supabase **SQL editor** for the production project.
3. Paste the full contents of
   `supabase/migrations/20261010120000_mcp_platform.sql` and run it **once**.
4. Then paste and run
   `supabase/migrations/20261011120000_mcp_oauth_client_restrictions.sql`
   **once** (it depends on the first). Each file is wrapped in
   `begin … commit`: on any error nothing from that file is applied. Run both
   as `postgres` (the SQL editor's role), so the `SECURITY DEFINER` functions
   are owned by a role that can read `auth.sessions`. (With the Supabase CLI,
   apply them through your normal migration process, in filename order.)
5. Verify, read-only:

   ```sql
   -- RLS on for all six tables (expect six rows, all true)
   select relname, relrowsecurity from pg_class
    where relname in ('customer_mcp_settings','customer_mcp_tools','mcp_user_blocks',
                      'mcp_connections','mcp_audit_log','mcp_idempotency_keys');

   -- The three functions exist, are SECURITY DEFINER, and anon cannot run them
   select p.proname, p.prosecdef, has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_my_mcp_context','mcp_is_own_membership','mcp_caller_is_blocked');

   -- The ACTUAL owner of get_my_mcp_context can read what the sign-out check
   -- needs (if either is false, MCP refuses every call as "unverified")
   select pg_get_userbyid(p.proowner) as owner,
          has_table_privilege(pg_get_userbyid(p.proowner), 'auth.sessions', 'select') as owner_reads_sessions,
          has_column_privilege(pg_get_userbyid(p.proowner), 'auth.users', 'banned_until', 'select') as owner_reads_ban
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_my_mcp_context';

   -- The OAuth-client restrictions are in place (expect 33 policies on 18 tables)
   select count(*) as restrictive_policies, count(distinct tablename) as tables
     from pg_policies
    where schemaname = 'public' and permissive = 'RESTRICTIVE' and policyname like 'oauth clients %';

   -- Helper functions exist and anon cannot run them (expect two rows, false)
   select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('mcp_request_is_oauth_client', 'mcp_oauth_writes_allowed');
   ```

   Expected: six rows with `relrowsecurity = true`; three functions with
   `prosecdef = true` and `anon_can_execute = false`; `owner_reads_sessions`
   and `owner_reads_ban` both `true`; 33 restrictive policies on 18 tables; the
   two helpers not executable by anon.

The migrations create empty tables and policies only, and change no existing
data.

**Rollback of the restrictions only** (if they ever block something they
should not): drop the 33 policies named `oauth clients …` and the two helper
functions. A generated script:

```sql
select format('drop policy %I on %I.%I;', policyname, schemaname, tablename)
  from pg_policies
 where schemaname = 'public' and permissive = 'RESTRICTIVE' and policyname like 'oauth clients %';
-- run the statements it prints, then:
-- drop function public.mcp_oauth_writes_allowed(uuid);
-- drop function public.mcp_request_is_oauth_client();
```

### 3. Deploy

Set `APP_URL` on Vercel (and optional variables), then deploy. Check:

```bash
curl -i -X POST https://<your-production-domain>/api/mcp
# expect 401 and a WWW-Authenticate header with resource_metadata=…
curl https://<your-production-domain>/.well-known/oauth-protected-resource/api/mcp
# expect JSON whose "resource" is exactly https://<your-production-domain>/api/mcp
curl -sI "https://<your-production-domain>/oauth/consent" | grep -iE "x-frame-options|content-security-policy"
# expect X-Frame-Options: DENY and frame-ancestors 'none'
```

### 4. Turn it on

An admin opens **Settings → AI Connections**, switches it **On**, reviews the
capabilities, and only then (optionally) enables **Allow changes** and
individual write tools.

---

## Administration (in the app)

**Settings → AI Connections** (admins; others see a refusal card):

- **Status and master switch:** Off / Ready / Used by N people.
- **"Claude sees exactly what each person sees":** the role explainer.
- **What Claude can do:** a searchable catalog grouped by Leads, Tasks,
  Contacts and Pipeline, with Read/Create/Update badges and a switch per tool;
  **Allow changes**, with a caution note (write switches stay locked while it
  is off).
- **Connect your AI:** the server URL with Copy (safe to share — each person
  signs in with their own account) and steps for Claude web/desktop, Claude
  Team/Enterprise, Claude Code (copyable command) and other clients. There is
  no one-click "Add to Claude" button: the deep link was not verified.
- **People and access:** every member, with their AI apps, last use, and
  Block/Unblock (works before a first connection; not on yourself).
- **Recent activity:** the latest audit rows with status badges.

**Settings → My AI Connections** (everyone): your connected apps, last use,
status (Connected / Disconnected / Blocked by your admin) and Disconnect.

---

## Runbook

| Symptom | Check |
|---|---|
| Client: "Couldn't reach the MCP server" | `curl -i -X POST $APP_URL/api/mcp` must give **401** with `WWW-Authenticate: Bearer resource_metadata=…`; the metadata's `resource` must equal the URL in the client exactly. |
| Sign-in works but every call is 401 | Token validation is refusing the token. Most likely `aud` or `client_id` differs from what was assumed (**UNVERIFIED**). Run the parity script — it prints the real claims — and fix with `MCP_ALLOWED_AUDIENCES`, never by weakening checks. Also possible: the session ended (signed out elsewhere). |
| Every call: "could not confirm that your sign-in is still active" | `session_state` is `missing_claim` (OAuth tokens lack `session_id`) or `unknown` (the function cannot read `auth.sessions`). Run the last verification query in the migration procedure and check the parity script's `session_id` check. Fails closed by design. |
| Consent: "This app isn't supported" | Redirect URI not on the allowlist. Add the exact callback of a legitimate client to `MCP_ADDITIONAL_REDIRECT_URIS`. |
| Consent: "Reconnect by adding the app again" | The person disconnected that OAuth client earlier; disconnects are final. Remove the connector in the AI app and add it again. |
| Claude Code: `invalid redirect_uri` on re-login | Supabase matches loopback ports exactly and Claude Code picks a new port per session. Use a fixed port (`claude mcp add … --callback-port 53682` or `MCP_OAUTH_CALLBACK_PORT=53682`) or remove and re-add the connector. |
| Every call: "turned off" | `customer_mcp_settings.enabled` is false for that company. |
| One person refused, others fine | Blocked (People and access), disconnected, Inactive membership, or their session ended. |
| "not approved through the consent screen" | A grant exists without an `mcp_connections` row (approved outside `/oauth/consent`). Remove and re-add the connector. |
| `rate_limited` | 60 calls/minute/person. Raise `MCP_RATE_LIMIT_MAX_CALLS` only with a reason. |
| Write tools missing | "Allow changes" off, or that tool's switch off. |
| Audit rows missing | Look for `[mcp] audit write failed` in Vercel logs (never contains values). |

**Rotate / revoke:**
- **One person, now:** Block them — also before they ever connect.
- **One app of yours:** Settings → My AI Connections → Disconnect.
- **Everyone, now:** switch AI Connections **Off**.
- **A compromised account:** sign them out globally or ban them in Supabase.
  MCP refuses on the next request (subject to the UNVERIFIED items above); also
  block them in the app.
- **Project-wide emergency:** disable the OAuth Server in Supabase. Existing
  access tokens stay valid until expiry — combine with the company switch.
- **Signing keys:** rotate in Supabase (Authentication → JWT Keys). The cache
  picks up a new key within `MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS`; no app
  change.

---

## Automated tests

Run locally; none touches production.

```bash
npx tsc --noEmit                            # TypeScript
npx eslint                                  # lint
npm test                                    # unit tests
npm run build                               # production build

npm install --no-save embedded-postgres pg  # once, for database tests
node test/db/boot.mjs                       # throwaway PostgreSQL on port 55432
node test/db/setup.mjs                      # apply every migration in order
node test/db/review10-mcp.mjs               # MCP schema/RLS/triggers/session checks
node test/db/review11-mcp-oauth-rls.mjs     # OAuth-client restrictions (app session vs OAuth token)
for t in review review2 review3 review4-loop-prevention review5-task-contact \
         review6-phase0 review7-task-contact-triggers review8-get-records \
         review9-coming-soon-sources; do node test/db/$t.mjs; done   # regression
```

| Suite | What it proves | Expected (2026‑10‑10) |
|---|---|---|
| `npm test` | domain-service behaviour (characterization), token claim rules, signing-key cache, access and session decisions, tool availability, filters and injection-shaped values, output and audit allowlists, idempotency (forged/stale/replay), orchestration, protocol wiring over the real SDK transport, anti-framing header rules, the 401-vs-tool-error decision, safe login return path | **380/380** pass |
| `review10-mcp.mjs` | the migration under real RLS with two companies and all roles: admin-only settings and blocks, pre-connection blocks, block isolation, connection ownership and timestamps, one-way disconnect, audit attribution/hashing/immutability/retention on deletion, idempotency transitions, session liveness (sign-out, time-box, ban, foreign/malformed session ids) | **105/105** pass |
| `review11-mcp-oauth-rls.mjs` | the same statements as the same people, as an app session and as an OAuth-client token: admin configuration blocked only for OAuth; integrations unreadable for OAuth; lead/task/contact writes blocked until AI connections and "Allow changes" are on, then still bound by RLS; meeting notes and dismissals blocked; company isolation; what the MCP server itself needs still works | **84/84** pass |
| `review` … `review9` | the existing schema, RLS and automation behaviour is unchanged (now with both migrations applied) | **385/385** pass |
| `tsc`, `eslint`, `next build` | — | clean; 0 lint errors (1 pre-existing warning in `pipeline-view.tsx`); build succeeds |

Live HTTP checks against `next start` (local): see
[What is verified](#what-is-verified-and-what-is-not).

---

## Manual verification procedure

Do these **after** applying the migration and deploying, with your own test
accounts and approved AI clients. They are the only way to prove the
**UNVERIFIED** items.

### 0. Test data, through the app only

| # | Company | Role | Reports to | Created with |
|---|---|---|---|---|
| 1 | MCPTEST Company A | Admin | — | `/signup` |
| 2 | A | Manager | A Admin | Settings → Add User |
| 3 | A | Senior Sales Rep | A Manager | Add User |
| 4 | A | Sales Rep | A Senior Rep | Add User |
| 5 | A | Sales Rep (peer) | A Admin | Add User |
| 6 | MCPTEST Company B | Admin | — | `/signup` |

- Use inboxes you control; confirm `+` aliases are delivered first.
- Invite in order: a manager must have accepted before being picked.
- Each person signs in once normally.
- As A Admin create `MCPTEST —` leads, tasks and contacts owned by each A user
  (include a task assigned to the Rep on the Manager's lead); as B Admin create
  a few in B. Plain forms only — no AI features.
- Turn **AI Connections on** for both companies.

### 1. Parity gate

Create `.env.mcp-gate` in the repository root (git-ignored):

```
GATE_ADMIN_EMAIL=<a-admin-email>        GATE_ADMIN_PASSWORD=<…>
GATE_MANAGER_EMAIL=<a-manager-email>    GATE_MANAGER_PASSWORD=<…>
GATE_SENIOR_EMAIL=<a-senior-email>      GATE_SENIOR_PASSWORD=<…>
GATE_REP_EMAIL=<a-rep-email>            GATE_REP_PASSWORD=<…>
GATE_PEER_EMAIL=<a-peer-email>          GATE_PEER_PASSWORD=<…>
GATE_TENANTB_EMAIL=<b-admin-email>      GATE_TENANTB_PASSWORD=<…>
GATE_MCP_URL=https://<your-production-domain>/api/mcp
```

Run `node supabase/analysis/mcp-parity-gate.mjs`. Leave `GATE_CLIENT_ID` unset
(disconnects are final, so a client cannot be reused across runs). It prints
only claims, counts and record ids. All checks must pass:

- OAuth token: signature, issuer, expiry, `role`, **`client_id`** and
  **`session_id`** present; the app session has no `client_id`; code replay
  refused. Note the printed `aud` — if it is neither `authenticated` nor the
  resource URL, set `MCP_ALLOWED_AUDIENCES`.
- For every person: OAuth token and app session see exactly the same leads,
  tasks, contacts and forecast.
- Hierarchy: Rep ⊆ Senior ⊆ Manager ⊆ Admin; Peer ⊆ Admin; no peer leads for
  Manager, Senior or Rep.
- Zero cross-company reads by id, both ways.
- At the endpoint: `search_leads` returns the app's leads with identity
  arguments ignored; an app session token is refused.
- Refresh rotates; revoking the grant stops refresh.
- Disconnect is refused on the next call and **cannot be undone** through the
  REST API with the same token.
- Admin block is enforced on the next call; unblocking restores access.
- **Global sign-out of the peer makes the next MCP call 401** (R3).
- **Direct Data API with the OAuth token:** a no-op lead write is blocked while
  "Allow changes" is off; registering a connection is refused; for the admin,
  integrations read as empty and a no-op MCP-settings change is refused.

Side effects (test accounts only): one OAuth client registered (delete it
afterwards), grants revoked at the end, one connection per test user marked
disconnected, audit rows, a temporary block on the Senior Rep, and a global
sign-out of the peer.

### 2. UI review (signed in)

- As A Admin, Settings → AI Connections renders. The master switch, Allow
  changes and tool switches persist after a reload. Search filters the
  catalog; Copy works; tabs work with the arrow keys.
- People and access lists every member. Block someone who has never connected
  and confirm their consent is then refused; unblock them.
- As the Rep: AI Connections shows the refusal card; My AI Connections lists
  and disconnects their app.
- Check at phone width and with the keyboard only.

### 3. Claude Code end to end

```bash
claude mcp add --transport http pipeway https://<your-production-domain>/api/mcp --callback-port 53682
```

1. `/mcp` → Authenticate. The consent screen shows the Rep's name and company
   and a loopback warning → Allow.
2. "What are my open leads?" must match the Pipeline for that person.
3. With writes off, ask for a task → refused (`tool_disabled`).
4. Admin enables Allow changes + Create tasks → create a task. It appears in
   Tasks, and any automation that a UI-created task would trigger runs.
5. The same create twice with one `idempotency_key` gives one task.
6. Disconnect in My AI Connections → the next request fails. Reconnect by
   removing and re-adding the connector.

### 4. claude.ai

Settings → Connectors → Add custom connector → URL → Connect → consent →
Allow. Repeat the read questions. Disconnect → the next request fails with
"You disconnected this AI app…".

### 5. Optional (UNVERIFIED Supabase behaviour)

- **Password change:** change the Rep's password, then make an MCP call with
  an unexpired token. Record whether it is refused.
- **Ban:** ban the Rep in Supabase (Authentication → Users), then make an MCP
  call. Expected: refused. Unban afterwards.

### 6. ChatGPT (only if wanted)

Add the connector in ChatGPT, copy the exact redirect URI from its MCP server
management page into `MCP_ADDITIONAL_REDIRECT_URIS`, redeploy, and repeat test
4 in ChatGPT.

Record each result, with its date, in the table below.

---

## What is verified, and what is not

| Item | Status | Evidence |
|---|---|---|
| OAuth discovery, DCR, authorize (PKCE required, redirect validated), token endpoint errors | Verified live 2026‑10‑10 | Phase 0 probes against the project. |
| Schema, RLS, triggers, context function, blocks, one-way disconnect, idempotency transitions, audit retention on deletion, session liveness (105 checks, two companies, all roles) | Verified (real PostgreSQL, local) | `review10-mcp.mjs` → 105/105 |
| No regression in existing schema/RLS/automation | Verified (local) | `review`…`review9` → 385/385 |
| OAuth-client restrictions on the Data API (claims set as PostgREST sets them) | Verified (real PostgreSQL, local) | `review11-mcp-oauth-rls.mjs` → 84/84 |
| Restrictions enforced with a real OAuth token against the deployed Data API | **UNVERIFIED** | Manual test 1 (direct Data API probes) |
| Audit retention function | Verified (local, rolled back) | correct rows only, idempotent, refuses < 30 days, not executable by app roles; `pg_cron` scheduling itself **UNVERIFIED** (not available locally) |
| Domain-service refactor behaviour | Verified (characterization) | `*-service.test.ts` |
| Token claim rules, header pre-checks, signing-key cache | Verified (unit) | `verify-token.test.ts`, `jwks-cache.test.ts` |
| Access decisions incl. session states, tool availability, call-time re-check | Verified (unit) | `access.test.ts` |
| Filter allowlist, injection-shaped values bound literally | Verified (unit) | `filters.test.ts` |
| Output allowlists, identity args stripped, registry invariants | Verified (unit) | `registry.test.ts` |
| Orchestration: disabled tools, writes off, rate limit, audit names allowlisted + key hashed, idempotency incl. forged/stale/RLS replay | Verified (unit) | `handle-call.test.ts` |
| SDK wiring over stateless HTTP | Verified (in-process) | `server.test.ts` |
| 401 + discovery header, metadata, CORS, forged/HS256/random-kid tokens rejected, consent redirect, anti-framing headers on `/oauth/*` only, one key download for repeated random kids | Verified (local `next start`) | curl |
| Typecheck, lint, build | Verified (local) | see [Automated tests](#automated-tests) |
| OAuth token parity per role; `client_id`, `aud`, `session_id` claims | **UNVERIFIED** | Manual test 1 |
| Session check works in production (`auth.sessions` readable, OAuth sessions deleted by global sign-out) | **UNVERIFIED** | Migration verification query; manual test 1 |
| Password change / ban effect | **UNVERIFIED** | Manual test 5 |
| Disconnect, block and their irreversibility at the deployed endpoint | **UNVERIFIED** live (verified locally) | Manual test 1 |
| End to end with Claude Code / claude.ai / ChatGPT | **UNVERIFIED** | Manual tests 3, 4, 6 |
| Deactivation / role downgrade mid-session | **DEFERRED, UNVERIFIED** | The app has no supported workflow for either yet |
| UI reviewed signed in (visual, responsive, keyboard) | **UNVERIFIED** | Manual test 2 |
| Supabase plan and OAuth beta notice | **UNVERIFIED** | Dashboard |

---

## Known limitations

1. **Direct Data API use of an OAuth token is only partly restricted.** The
   restrictive policies block administrative writes, integration reads,
   meeting-note and dismissal writes, and lead/task/contact writes while
   "Allow changes" is off. Still possible directly, until the token expires:
   reads of what the person can see (except integrations); with "Allow
   changes" on, lead/task/contact writes not limited to enabled tools or tool
   fields; Storage writes. MCP rate limits, audit and the session check do not
   apply to direct requests. See [Direct Data API access](#direct-data-api-access-by-oauth-tokens).
2. **Supabase OAuth 2.1 Server is in public beta.** Re-run the parity script
   after Supabase changes. Plan and beta notice are **UNVERIFIED**.
3. **`client_id`, `aud` and `session_id` claims are UNVERIFIED** against a live
   token. If any differs from expectations, MCP refuses every call (fails
   closed); fix by configuration, never by weakening checks.
4. **The session check relies on Supabase's documented `auth.sessions` table**
   being readable by the migration owner. If not, `session_state` is `unknown`
   and MCP refuses calls (the rest of the app is unaffected).
5. **Password change and Supabase-side grant revocation** only affect MCP
   immediately if Supabase ends the token's session; whether it does is not
   assumed (**UNVERIFIED**). Otherwise the token works until expiry (≤ 1 h by
   default).
6. **Admins cannot revoke another person's Supabase grant** (that needs the Auth
   admin API, i.e. the banned service-role key). The per-person block is
   enforced on every request instead.
7. **Deactivation and role downgrade mid-session are DEFERRED and UNVERIFIED.**
   The design re-reads both on every request, but the app has no supported way
   to change them yet. Until then, block the person or turn the company switch
   off.
8. **The audit log is an activity log, not security evidence** — see
   [Audit](#audit-logging-privacy-and-retention).
9. **Timeouts on writes:** a timed-out write may still complete; its key stays
   pending so a retry with the same key cannot duplicate it.
10. **Reconnecting after a disconnect requires re-adding the connector**
    (disconnects are final per OAuth client).
11. **Dynamic Client Registration accumulates clients** (one per fresh
    connection). Harmless; prune them in Authentication → OAuth Apps.
12. **Claude Code loopback ports** — see the runbook.
13. **ChatGPT is not configured by default** — see [Supported clients](#supported-clients).
14. **No "Add to Claude" one-click button** — the deep link was not verified.
15. **The automation drain after `create_lead`** is the same post-response
    nudge the form fires (`drainAutomationQueue`). It runs under the existing
    automation worker path, never receives MCP input and never uses the
    person's token.
16. **Settings pages and the consent screen were type-checked, linted and
    built, but not visually reviewed while signed in** (**UNVERIFIED**).

---

## Extending

- **A new tool:**
  1. Add a definition in `features/mcp/registry/tools/*.ts`: label, summary,
     description, group, kind, capability, a Zod **object** input with no
     identity fields, `outputFields`, and a handler that projects through
     `lib/output.ts`.
  2. For creates, set `idempotent: true` and `replayTable`.
  3. List it in `registry/index.ts`.

  Writes must call a domain service in `features/*/lib/*-service.ts`, never a
  second copy of business logic. The registry tests fail if names,
  annotations, output lists, parameters or replay tables are unsafe.
- **A new filterable field:** add it to the object's `FilterSpec` in
  `registry/fields.ts`. Add its column to `*_SELECT` only if the app already
  shows it.
- **A new client:** verify its callback in that client's own documentation,
  then add the exact URI to `config/clients.ts` or
  `MCP_ADDITIONAL_REDIRECT_URIS`.
- **A new limit:** add it to `config/limits.ts` and document it here.
