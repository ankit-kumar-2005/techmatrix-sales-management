# Automations — operations and honest limits

Written for: whoever deploys, operates or extends this feature next.

This is the first feature in the app that **creates real business records with
nobody watching**. Everything below follows from that. It is deliberately
written to be useful when something has gone wrong at 3am, so the limitations
section is as long as the setup section.

---

## Required setup, in order

The feature is inert until both of these are done. It fails closed — no
automation runs, nothing is lost, and the reason appears in the server log.

### 1. Apply the migration

```
supabase/migrations/20260921120000_automations.sql
```

It creates four tables, one config table, ten functions, one trigger on
`public.leads`, and adds one nullable column (`tasks.automation_key`) with a
partial unique index. It is additive: no existing column, constraint, policy or
row is altered or dropped.

### 2. Mint the worker token

The migration stores **no token**. Mint one from a SQL console:

```sql
select public.rotate_automation_worker_token();
```

It returns the token **once** — copy it into `AUTOMATION_WORKER_TOKEN`. Only its
SHA-256 hash is stored, so the plaintext exists nowhere afterwards and cannot be
recovered. Lose it and you mint another.

Until you do this, the feature is inert: `verify_automation_worker` returns false
for everything and the engine logs the exact step it is waiting on.

**Rotation.** The same call rotates. The outgoing hash stays valid for an overlap
window (default 1 hour) so you can rotate, then deploy the new environment value,
without a gap where every automation is broken:

```sql
select public.rotate_automation_worker_token();                  -- 1h overlap
select public.rotate_automation_worker_token(interval '10 min'); -- shorter
select public.rotate_automation_worker_token(interval '0');      -- revoke NOW
```

Use `interval '0'` for a suspected leak — it invalidates the previous token
immediately, at the cost of breaking automations until the environment catches up.

**Why a token at all.** The engine runs from cron with no user session, so
`auth.uid()` is null, `is_customer_user_visible()` is false, and `anon` holds no
grant on `tasks`. The privileged write therefore lives in the database behind a
fixed signature (`create_automation_task`), exactly as `ingest_lead()` does.
Those functions are granted to `anon` because the session-less client calls
them — **the grant is not the boundary, the token check at the top of every one
of them is**. Without it, anyone on the internet could drain the queue and read
other tenants' events.

**Claim ownership is a second, narrower credential.** The worker token says "you
are the worker". Claiming an event additionally mints a per-claim `claim_token`
which that worker must present back before it may finish the event or record a
run against it. Both are required, because the first cannot express the second —
see the finding log below.

### 3. Set `CRON_SECRET` (production only)

`/api/cron/automations` refuses to run in production without it (503). Vercel
Cron sends `Authorization: Bearer $CRON_SECRET` automatically; any external
scheduler must send the same header.

### 4. Optional: `OPENROUTER_API_KEY`

Already set if Meeting Notes works. Without it the AI builder returns a clear
"not configured on this deployment" and the blank-canvas path is unaffected.

---

## How an event gets processed

```
lead inserted (Server Action OR ingest_lead webhook)
   │
   ├─ AFTER INSERT trigger on leads, in the SAME transaction
   │     → automation_events row, status 'pending'   (only if the tenant
   │                                                  has an Active automation)
   │
   ├─ after() on the same request  →  drainAutomationQueue()   ← low latency
   └─ cron, on a schedule          →  processAutomationEvents() ← durability
                                          │
                     claim_automation_events (FOR UPDATE SKIP LOCKED)
                                          │
                     depth → ancestry → action budget  (safeguards)
                                          │
                     validateWorkflow  →  planWorkflow  →  executor
                                          │
                     create_automation_task (SECURITY DEFINER, idempotent)
                                          │
                     record_automation_run  +  complete_automation_event
```

**The outbox is written by a database trigger, not by application code**, because
leads are created by two paths (`features/leads/actions.ts` and `ingest_lead()`)
and only a trigger is genuinely in-transaction with both. An outbox written in
TypeScript would silently miss every webhook-captured lead — the flagship case.

---

## ⚠️ Scheduling: the real limitation

**Vercel's cron minimum interval depends on the account plan** — once per *day*
on Hobby, once per *minute* on Pro. This repository is **not linked to a Vercel
project** (no `.vercel/`, and `APP_URL` still points at `localhost:3000`), so the
plan could not be inspected and nothing here assumes one.

`vercel.json` therefore ships a **daily** schedule, which is the only value that
deploys successfully on every plan.

**The feature does not depend on cron for latency.** The low-latency path is
`after()` on the request that created the lead: the webhook returns its 200 to
the source first, then the queue is drained in the background, so a task
normally appears seconds after a lead arrives. The automations page does the same
when it sees a backlog. Cron exists for the three cases that have no request of
their own to ride on: **retrying a failed event, recovering a claim left behind
by a worker that died mid-run, and anything the opportunistic path missed because
the process ended first.**

**What the daily schedule actually costs you:** a transient failure — a database
blip, a moment of OpenRouter unavailability — can leave a task delayed by up to a
day instead of retried within a minute.

**On Pro, change the schedule to `* * * * *`.** Not on Vercel at all? Any
scheduler that can issue an authenticated `GET` works; point it at
`/api/cron/automations` with the bearer header.

---

## Safeguards

Every limit lives in exactly one place: `features/automations/config/safeguards.ts`.
The SQL functions take their limits as **parameters** — the database is
deliberately incapable of holding an opinion of its own about any of them.

| Safeguard | Bounds |
|---|---|
| `MAX_ACTIONS_PER_EVENT` | fan-out: total actions across every automation descended from one event |
| `MAX_WORKFLOW_DEPTH` | chain: generations of event one action may set off |
| `MAX_RETRIES_PER_EVENT` | claims before an event is retired to `dead` |
| `PROCESSING_TIMEOUT_SECONDS` | how long a claim is held before another worker may reclaim it |
| `MAX_NODES_PER_WORKFLOW` / `MAX_EDGES_PER_WORKFLOW` | graph size |
| `EVENT_BATCH_SIZE` | events per invocation |

**Every safeguard stop is recorded** in `customer_automation_runs` with
`status = 'stopped_by_safeguard'` and a `stop_reason` — enforced by a CHECK
constraint, so a stop cannot be stored without saying which safeguard fired.

### ⚠️ Loop prevention is enforced but **not reachable in v1**

In v1 the only trigger is `lead.created` and the only action is `task.create`.
Creating a task does not create a lead, so **no action can raise an event, and no
cycle can be constructed** — not by hand in the builder, and not by the AI
builder either.

**So no end-to-end cycle test exists, and none is claimed.** What is verified
instead: the four decision functions in `lib/safeguards-check.ts` are unit-tested
directly (`safeguards-check.test.ts`, 14 assertions) with the inputs a real
second-generation event would carry — including a two-automation A→B→A cycle and
a self-cycle. The engine calls exactly those functions; there is no second copy
of any rule inside it.

**What remains unverified** is the wiring from a real second-generation event
into them, because no such event can exist until a second trigger is added. When
one is, that end-to-end test becomes both possible and necessary.

---

## Idempotency — two independent layers

They fail differently and neither substitutes for the other.

1. **`tasks.automation_key`** + partial unique index on
   `(customer_id, automation_key) where automation_key is not null`. Modelled
   directly on `leads_external_source_unique`. The key is
   `a:{automation}:v{version}:e:{event}:n:{node}` — deterministic, so a retry in
   a different process minutes later computes the same string. Nothing in it
   reads a clock or a random source.
2. **`unique (automation_id, event_id)`** on `customer_automation_runs` — one
   automation produces at most one run per event, whatever happens upstream.

`create_automation_task` checks idempotency **before** resolving the assignee, so
a redelivery cannot burn a round-robin participant's turn — the same bug
`ingest_lead()` documents in its own step 2.

---

## Versioning

`customer_automations` holds identity and mutable operational state (status,
rotation cursor). `customer_automation_versions` holds **insert-only** snapshots
— no UPDATE policy and no UPDATE grant, so immutability is a permission rather
than a convention.

Saving an Active automation inserts a new version and **leaves
`active_version_id` alone**. The engine resolves the active version at claim time
and reads an immutable snapshot, so an in-flight execution is structurally
incapable of being affected by a concurrent edit. The builder says outright when
the version you are editing is not the version that is running.

---

## Security posture

- **All four tables are ADMIN-only for SELECT as well as writes** —
  `is_customer_admin(customer_id)`, following `customer_integrations` rather than
  `tasks`. An automation defines privileged unattended behaviour and its history
  can name records across the whole reporting hierarchy.
- **`customer_id` is never accepted from the client.** No schema in this feature
  has a field for it; it is resolved from the verified session in `actions.ts`.
- **`automation_events` and `customer_automation_runs` are read-only to
  `authenticated`** — written only by the trigger and the token-gated functions.
- **`verify_automation_worker` is granted to nobody**, so it cannot be used as an
  oracle to test candidate tokens.
- **Every SECURITY DEFINER function pins `search_path = public`.**
- **The AI never generates code.** It selects a `type` from the registry and
  fills a `config` parsed by that entry's own Zod schema. An unregistered type has
  nothing to look up, so the generation is refused — that is the mechanism, not a
  filter kept in sync with it. The model is never sent a UUID: team members are
  opaque refs (`member_1`) mapped back server-side from a directory the acting
  admin could already see.
- **One execution path.** `origin` is recorded for history and read by nothing
  that runs. `get_active_automations` — the engine's only source of automations —
  does not select the column, so an `if (origin === "AI")` branch is not merely
  absent, it is unwritable without changing the function's signature.

---

## Security review findings (all fixed, all verified against real PostgreSQL)

A review ran the migration and 164 behavioural assertions against a real
PostgreSQL 18 instance. Fourteen defects were found and fixed. They are recorded
here because several were invisible to static reading, and a future change could
reintroduce any of them.

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | `create_automation_task` never checked that `automation_id` belonged to `customer_id` — another tenant's automation id created a task | High | Tenancy + eligibility check; composite FK `tasks(customer_id, automation_id)` as a second layer |
| 2 | Same function executed for **Draft** and **Inactive** automations — "switched off" did not mean switched off | High | `automation_not_active` refusal |
| 3 | Same function accepted a **nonexistent** `automation_id` | Medium | `invalid_automation` refusal |
| 4 | **A stale worker could complete another worker's claim.** Its only guard was `status = 'processing'`, so a worker whose claim had been reclaimed could mark an event succeeded *while a second worker was still running it* — a genuine failure could be stored as a success | **Critical** | Per-claim `claim_token`, minted on claim and required back by `complete_automation_event` and `record_automation_run` |
| 5 | `record_automation_run` let one tenant record a run citing another tenant's event, corrupting the audit trail | Medium | Composite FK on `(customer_id, event_id)` + ownership check |
| 6 | No way to tell which automation created a task, except by substring-parsing the idempotency key | Medium | `tasks.automation_id`, a real FK column |
| 7 | `created_by` was forgeable — an admin could POST through PostgREST attributing an automation to a colleague | Low | `created_by = auth.uid()` in both INSERT policies |
| 8 | **`verify_automation_worker` was callable by `anon` and `authenticated`** — a free oracle for testing candidate worker tokens. The migration said `revoke all … from anon, authenticated`, which removes grants those roles never individually held while PostgreSQL's **default grant to `PUBLIC`** carried on | **High** | `revoke … from public` on every function, then explicit grants. `PUBLIC` now holds EXECUTE on nothing |
| 9 | The worker token was stored in **plaintext** — a dump, backup or future policy slip would hand over a cross-tenant credential | High | Only a SHA-256 hash is stored; the plaintext is shown once and never persisted |
| 10 | **No rotation path.** Changing the token meant a window where the database and the environment disagreed and every automation was broken | Medium | `rotate_automation_worker_token([overlap])` with a validity window for the outgoing hash |
| 11–13 | `set_automation_event_root` did not pin `search_path`; `automation_events.root_event_id` was nullable; step numbering in `create_automation_task` was wrong after edits | Low | Pinned, `not null`, renumbered |
| 14 | **The claim-ownership check in `record_automation_run` was NULL-safe and state-blind.** It used `e.claim_token is not distinct from p_claim_token`, which returns TRUE when *both* sides are NULL — so `p_claim_token = NULL` matched any **unclaimed** event and wrote run history against work nobody was processing. Separately, because `complete_automation_event` deliberately leaves `claim_token` set on terminal statuses, a stale-but-matching token was also accepted against an already-**succeeded/failed/dead** event | **High** | Explicit `p_claim_token is null` guard, plain `=` instead of `is not distinct from`, and `status = 'processing'` required. Regression test: `test/db/exploit-claim-null.mjs` (16 assertions) |

Finding 8 is the one worth remembering: a **static audit of this migration had
previously reported that function as locked down**, and it was not. Only running
it showed otherwise.

One near-miss from the same session: revoking EXECUTE on
`enqueue_lead_created_event` would have broken lead creation for every real user
if PostgreSQL checked that privilege when a trigger *fires* rather than when it
is *created*. It does not — and there is now an explicit regression test
(`7.12b`) that inserts a lead as a real `authenticated` caller and asserts the
outbox still receives the event.

---

## What IS and is NOT verified

**Verified against a real PostgreSQL 18 instance** (25 migrations applied in
filename order onto a reconstructed Supabase environment — `auth.uid()`, the
`anon`/`authenticated`/`service_role` roles, `storage`):

- The migration **applies cleanly**, with no SQL errors.
- **Tenant isolation across two real tenants** with a full role hierarchy
  (ADMIN, MANAGER, SENIOR_SALES_REP, SALES_REP): Customer B sees zero of
  Customer A's automations, versions, events and runs; cross-tenant inserts and
  updates are refused; non-admins see nothing at all; `anon` is refused on all
  four tables.
- **Genuine concurrency** — two simultaneous connections claiming from a
  20-event backlog: no event claimed twice, all 20 claimed exactly once.
- **Task idempotency under a real race** — two concurrent calls with the same
  key: one `created`, one `duplicate`, exactly one row.
- **Stale recovery and the retry ceiling** — an event dies after exactly
  `MAX_RETRIES_PER_EVENT` attempts.
- **Round-robin** — pool order, wrap-around, inactive members skipped, and a
  duplicate not advancing the cursor.
- **End to end**: inserting a real lead fires the trigger, writes the outbox
  row with the correct snapshot, the worker claims it, reads the lead's facts,
  creates a **real task** with the right tenant/lead/assignee/priority,
  `created_by` NULL and `automation_id` set, records the run, and closes the
  event. And a tenant with no Active automation gets **no event at all**.
- **Token handling** — hash-only storage, rotation with overlap, immediate
  revocation, and every worker function refusing a wrong token.
- Every SECURITY DEFINER function pins `search_path`; no function is left on
  PostgreSQL's default ACL.

**Still NOT verified:**

- **Least privilege on function ownership.** Every function is owned by the
  migration runner (`postgres`), so SECURITY DEFINER runs with that role's
  rights — broader than the handful of tables these functions touch. A dedicated
  low-privilege owner role would be tighter. Not done here because creating
  roles interacts with how Supabase manages its own, and it is a deployment
  change rather than a defect. The exact SQL is in the review report.
- **No lead was captured from IndiaMART end to end.** The database half of that
  chain is now proven; the HTTP half needs the user's own IndiaMART account and a
  deployed origin (`APP_URL` is still `localhost:3000`).
- **The AI builder was not called live.** Its output contract is enforced by Zod
  and the registry; no request reached OpenRouter.
- **Loop prevention remains unreachable in v1** (see above) — unit-tested
  directly, not exercised end to end, because no cycle can be constructed.
- The harness reconstructs Supabase's environment rather than being Supabase.
  `auth.uid()` and the roles behave the same way, but RLS on a real Supabase
  project should still be spot-checked after applying.

**Also verified in the application:** TypeScript (clean), ESLint (clean), the
production build (succeeds), and 95 unit tests over the pure logic.

## Reproducing the database tests

The harness lives in `test/db/`. It needs two packages that are deliberately
**not** in `package.json` — `embedded-postgres` downloads ~100 MB of PostgreSQL
binaries, which should not be in every developer's install:

```
npm install --no-save embedded-postgres pg
node test/db/boot.mjs      # initdb + start on port 55432
node test/db/setup.mjs     # apply all migrations
node test/db/review.mjs    # tenancy, roles, claims, concurrency, idempotency
node test/db/review2.mjs   # SECURITY DEFINER audit, end to end, rotation
node test/db/exploit-claim-null.mjs  # regression: NULL/state-blind claim ownership
```
