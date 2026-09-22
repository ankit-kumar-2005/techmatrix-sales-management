# Automation engine — the technical mechanics

`docs/automations.md` documents this feature's behavior, history and security
review. This is the companion piece: **how the event pipeline actually
works** — the queue, the workers, the async triggering, the concurrency
control, and the safeguards — for someone who needs to reason about or debug
the machinery itself rather than the workflows it runs.

Everything here is backed by real code, cited by file and line. Nothing in
this document is aspirational.

---

## 1. There is no message broker. The queue is one Postgres table.

No SQS, no Redis, no BullMQ, no long-running worker process. The entire
queue is `public.automation_events`
(`supabase/migrations/20260921120000_automations.sql:401-469`), a plain
table with a `status` column:

```sql
status text not null default 'pending'
  check (status in ('pending', 'processing', 'succeeded', 'failed', 'dead')),
attempts integer not null default 0,
claimed_at timestamptz,
claim_token uuid,
processed_at timestamptz,
```

A row is inserted by an `AFTER INSERT`/`AFTER UPDATE` trigger on `leads`,
`tasks`, or `contacts` (`enqueue_lead_automation_event` and its Task/Contact
equivalents) — **in the same transaction** as the write that caused it. That
is the entire "publish" side of this queue: an ordinary row insert, committed
atomically with the business event it describes. There is no separate
publish step to fail or to lose.

The "subscribe" side — claiming and processing rows — is a SQL function
called `claim_automation_events`, described in full below. This pattern (a
table that plays queue, fed by a trigger, drained by a polling claim) is
usually called the **transactional outbox pattern**, and it exists
specifically to avoid the classic "dual write" bug: writing a business row
and separately publishing an event to a real queue can never be made atomic
across two different systems. Here there is only one system, one
transaction, and one row.

---

## 2. The lifecycle of one event

```
        AFTER INSERT/UPDATE trigger (same transaction as the lead/task/contact write)
                          │
                          ▼
                    ┌───────────┐
                    │  pending  │◄────────────────────────┐
                    └─────┬─────┘                         │
                          │ claim_automation_events()      │ processing timed out
                          │ (FOR UPDATE SKIP LOCKED)       │ (claimed_at older than
                          ▼                                │  PROCESSING_TIMEOUT_SECONDS)
                    ┌────────────┐                         │
                    │ processing │─────────────────────────┘
                    └─────┬──────┘
              complete_automation_event(status, retryable)
                          │
           ┌──────────────┼───────────────┐
           ▼               ▼               ▼
     ┌───────────┐  ┌───────────┐   ┌─────────────┐
     │ succeeded │  │  pending  │   │    dead     │
     └───────────┘  │ (retry)   │   └─────────────┘
                     └───────────┘   attempts reached
                                      MAX_RETRIES_PER_EVENT
```

- **`pending`** — newly enqueued, or returned to the queue after a retry or a
  stale-claim recovery.
- **`processing`** — claimed by exactly one worker invocation, holding a
  `claim_token` (a fresh random UUID minted at claim time,
  `engine.ts` calls this the row's *ownership token*).
- **`succeeded` / `dead`** — terminal. `dead` is reached only after
  `attempts >= MAX_RETRIES_PER_EVENT` (currently **3**,
  `safeguards.ts:59`) — this is what the Automations page's "N gave up after
  repeated failures" count reflects.
- There is no separate `failed` **resting** state in practice — a retryable
  failure goes straight back to `pending` (see §4); `failed` only shows up
  transiently in `ProcessResult` counters and in `customer_automation_runs`
  history, not as something a row sits in.

---

## 3. Claiming: how concurrent workers don't collide

`claim_automation_events` (`...automations.sql:627-705`) is the one function
that turns "a table with a status column" into an actual queue with
exactly-once-in-flight semantics. Its core is one SQL statement:

```sql
with candidate as (
  select e.id
    from public.automation_events e
   where e.status = 'pending'
     and e.attempts < p_max_attempts
   order by e.created_at
   for update skip locked
   limit p_batch_size
)
update public.automation_events e
   set status = 'processing',
       claimed_at = now(),
       claim_token = gen_random_uuid(),
       attempts = e.attempts + 1
  from candidate c
 where e.id = c.id
returning ...;
```

`FOR UPDATE SKIP LOCKED` is what makes this safe under real concurrency: if
two invocations of `processAutomationEvents()` run at the same moment
(entirely possible — the opportunistic path can fire from two different
lead-creation requests within the same second, or a fast-path drain can
overlap with the cron route), each one's `SELECT ... FOR UPDATE` locks the
rows it's about to claim. The *other* invocation's `SKIP LOCKED` clause means
it silently skips those rows and claims a **different** batch instead of
blocking on the lock or claiming the same row twice. No application-level
mutex, no distributed lock service — this is a single, well-understood
Postgres primitive doing the entire job.

**Stale-claim recovery** happens in the same function, just before claiming:

```sql
update public.automation_events
   set status = 'pending', claimed_at = null, claim_token = null,
       last_error = 'Reclaimed after exceeding the processing timeout.'
 where status = 'processing'
   and claimed_at < now() - make_interval(secs => p_timeout_seconds);
```

If a worker claims a batch and then genuinely dies mid-processing (a crashed
serverless function, a killed local dev process), the row would otherwise sit
in `processing` forever. `PROCESSING_TIMEOUT_SECONDS` (**300s**,
`safeguards.ts:71`) bounds how long that can last — the *next* invocation of
`claim_automation_events`, whenever it runs, reclaims anything stuck longer
than that back to `pending` before claiming anything new. `attempts` was
already incremented at the original claim, so a row that keeps dying this way
is still bounded by `MAX_RETRIES_PER_EVENT` and eventually goes `dead` rather
than retrying forever.

**Batching is deliberate, not incidental.** `EVENT_BATCH_SIZE = 25`
(`safeguards.ts:83`) bounds how many rows one invocation claims. A serverless
function invocation has a wall-clock ceiling (`maxDuration = 60` on the cron
route); claiming an unbounded backlog in one call risks the function being
killed mid-batch, which is exactly what the stale-claim recovery above exists
to clean up after. A backlog is worked off across several invocations
instead.

---

## 4. What "processing" one event actually does

`processEvent()` (`engine.ts:168-426`) is a single function that runs
**every** matching automation for one claimed event, in this exact order,
each step gated behind the previous one succeeding:

1. **Depth safeguard** (`checkEventDepth`, before any query) — bounds how
   deep a chain of automation-triggered automation-triggered-automation can
   go. `MAX_WORKFLOW_DEPTH = 3` (`safeguards.ts:48`).
2. **Load active automations** for this event's `(customer_id, event_type,
   operation)` via `get_active_automations` — if none match (e.g. the
   automation was deactivated in the gap between enqueue and processing),
   the event is closed as `skipped`, not retried.
3. **Load facts** — the record's current field values, shaped for the
   condition/template engine. A Lead event does a live re-read (so a
   template always reflects the record's current display fields); a
   Task/Contact event builds facts directly from the claimed row's own
   `new_values`/`old_values` snapshot, no extra query.
4. **Load lineage** (`get_automation_lineage`) — the running total of
   actions already executed, and which automation IDs have already run,
   anywhere in this event's `root_event_id` ancestry. Read **once** per
   event, then carried and updated in memory as this event's own automations
   run.
5. For **each** matching automation, in order:
   - **Ancestry safeguard** — has this exact automation already run
     somewhere in this lineage? If so, this is a cycle, and the automation
     is stopped, not executed (`stopped_by_safeguard`).
   - **Action-budget safeguard** — would running this automation risk
     exceeding `MAX_ACTIONS_PER_EVENT` (**10**, `safeguards.ts:34`) across
     the whole lineage? If the budget is already spent, stop here too.
   - **Re-validate the stored definition** (`validateWorkflow`) — a
     definition that was valid when saved may not be valid under today's
     rules; this is the last gate before anything real happens.
   - **Plan** (`planWorkflow`) — a pure function: given the definition and
     the facts, produce an ordered list of concrete actions to run. No I/O.
   - **Execute** each planned action sequentially through the executor
     registry (`registry/executors.ts`), each one an actual Supabase RPC
     call (`create_automation_task`, `update_lead_via_automation`,
     `get_automation_records`, the `loop` executor recursing into its body
     action, etc.).
   - **Record the run** (`record_automation_run`) — every outcome, success
     or not, is written to `customer_automation_runs`. This is what backs
     the Execution History list — a skip and a safeguard stop are recorded
     exactly as deliberately as a success.
6. **Release the claim** (`complete_automation_event`) — see §5.

**Why sequential, not `Promise.all`, within a batch**
(`engine.ts:147-152`): two events for the same tenant can resolve the same
round-robin assignment rotation, and that rotation cursor is advanced under
a row lock. Running events concurrently within one invocation would just
have them queue on that lock anyway, while making a given failure harder to
attribute to a specific event. Throughput comes from batch size and
invocation frequency, not from intra-batch concurrency — this is a
deliberate simplicity-over-throughput tradeoff, reasonable at this
feature's actual volume (see the 100-lead bulk-load numbers in
`docs/automations.md`).

**One event's failure never takes the batch down** — each `processEvent`
call is individually wrapped in try/catch inside the batch loop
(`engine.ts:153-163`); a thrown error there is caught, counted, logged, and
the event is released as `failed` before moving to the next one.

---

## 5. Completing: the claim token as a second credential

`complete_automation_event(p_event_id, p_claim_token, p_status, ...)`
(`...automations.sql:787-845`) is how a worker releases what it claimed —
and it is deliberately **not** the same credential as the worker token.

- `AUTOMATION_WORKER_TOKEN` says *"you are allowed to act as the automation
  worker at all"* — one shared secret for the whole deployment.
- `claim_token` says *"you specifically are the one who claimed **this**
  row, just now"* — minted fresh per claim, per row.

Both are required because the first cannot express the second: knowing the
shared worker token proves you're *a* worker, not that you're *the* worker
who currently owns this particular row. Two overlapping invocations (see
§3) could otherwise race to complete the same event.

The completion check is a plain `=`, never `IS NOT DISTINCT FROM`:

```sql
where e.status = 'processing' and e.claim_token = p_claim_token
```

`test/db/exploit-claim-null.mjs` exists specifically to pin this: `IS NOT
DISTINCT FROM` is NULL-safe equality, so it would have returned `true` when
**both** sides are NULL — and an unclaimed row has `claim_token = NULL` by
default. A caller passing no claim token at all would have matched every
unclaimed row in the table. The plain `=` makes a NULL claim token match
nothing, ever.

Depending on the outcome passed in:
- `succeeded` / non-retryable `failed` → status becomes terminal,
  `claim_token` and `claimed_at` are **left in place** as a record of which
  claim actually finished it.
- retryable `failed` → status returns to `pending`, `claim_token` and
  `claimed_at` are cleared — the row re-enters the pool for
  `claim_automation_events` to pick up again (bounded by `attempts` as
  always).

---

## 6. Two triggers, one worker function, and what "async" means here

There is exactly **one** function that does real work: `processAutomationEvents()`
(`engine.ts:118`). Two different things call it, for two different reasons —
but neither of them is a persistent "worker process" in the traditional
sense. There is no long-running daemon anywhere in this design. A "worker"
here means: **one bounded, stateless invocation of `processAutomationEvents()`**,
claiming and draining a batch, then exiting. Nothing survives between
invocations except the state committed to Postgres.

### 6a. The opportunistic path — `next/server`'s `after()`

```ts
// app/api/webhooks/leads/[source]/[token]/route.ts
if (result === "created") {
  after(() => drainAutomationQueue(`a ${source} lead was captured`));
}
return NextResponse.json({ status: result }, { status: 200 }); // sent immediately
```

`after()` is a Next.js primitive that schedules a callback to run **after
the HTTP response has already been sent to the client**, but while the
underlying function invocation is still allowed to keep running (on Vercel,
this extends the serverless function's lifetime past the response; it does
**not** make the client wait, and it does **not** run in a separate process
or a separate request). Concretely, for the IndiaMART webhook: the source
gets its `200` the instant `ingest_lead()` returns — automation processing
has not even started yet — and then, in the same function instance,
`drainAutomationQueue()` runs to completion (or fails) with nobody waiting
on it.

This is genuinely asynchronous relative to the request/response cycle (the
caller never sees it, never waits for it, and cannot be slowed or failed by
it), but it is **not** "fire into the void and hope" — `drainAutomationQueue`
is awaited by the `after()` callback, its result is logged, and — as of this
session's fix — its one previously-silent failure mode
(`AUTOMATION_WORKER_TOKEN` unset) now logs a specific, actionable message
every time, and never throws out of `after()` itself.

Three call sites use this same pattern: a lead being captured through the
generic webhook route, a lead being created through the in-app form
(`features/leads/actions.ts`), and — opportunistically — anyone opening the
`/automations` page while a backlog exists (`app/(app)/automations/page.tsx`).
The last one exists purely as an extra nudge: an admin looking at "N waiting
to be processed" is itself a signal that a retry is welcome right now.

### 6b. The durable backstop — the cron route

```ts
// app/api/cron/automations/route.ts
export async function GET(request: Request) {
  // ... CRON_SECRET check ...
  const result = await processAutomationEvents();
  return NextResponse.json({ status: "ok", ...result });
}
```

Configured in `vercel.json` to run once daily (`0 3 * * *`) — this project's
hosting plan tier could not be confirmed at the time this was set up, and a
daily schedule is the one value guaranteed to deploy on every plan. On a
plan that supports per-minute crons, this should be tightened
(`* * * * *`), since **the opportunistic path is not meant to be the only
mechanism** — it is the low-latency path, while cron is what retries a
failed event, recovers a stale claim, and catches anything the opportunistic
path missed (a request that crashed before `after()` ran, a cold start that
got killed, etc.). Neither path is load-bearing on its own; together they
are correct on any plan, just with different worst-case latency.

### 6c. The gap this session's fix closes: local development has neither

Vercel Cron does not run locally under `next dev` — there is no background
scheduler simulating it. So locally, the *only* mechanism that can ever
process an event is the opportunistic `after()` path, firing exactly once,
at the moment a lead is captured. If that single opportunistic attempt fails
for any reason (as it did here — see §8), there is **no** automatic retry
available at all until either another lead is captured (nudging the queue
again) or a day passes and a deployed cron would have fired (which still
doesn't exist locally). `features/automations/components/process-queue-now-button.tsx`
and `processQueueNowAction()` (`features/automations/actions.ts`) exist to
fill exactly this gap: a manual, admin-gated, awaited call to the same
`processAutomationEvents()`, visible only when `NODE_ENV !== "production"`
(computed server-side, never client-inferred, and refused again by the
action itself as a second, independent gate) — a local stand-in for "cron
fired right now," on demand.

---

## 7. Authentication: no service-role key, anywhere

Every Supabase client this feature's engine uses
(`lib/supabase/webhook.ts`) is built with the **anon** publishable key, never
a service-role key. There is no elevated, all-tables-visible credential
floating around this codebase at all for this feature. Instead:

- Every RPC the engine calls is `SECURITY DEFINER`, with `search_path`
  pinned, and independently re-verifies the caller's `p_token` against
  `automation_worker_config` (`verify_automation_worker`) before doing
  anything.
- `AUTOMATION_WORKER_TOKEN` is the **only** thing that lets an anon-role
  caller act as "the automation worker." It is never stored in plaintext in
  the database — only its SHA-256 hash is (`automation_worker_config.token_hash`) —
  minted once via `select public.rotate_automation_worker_token();`, shown
  exactly once, and unrecoverable afterward (lose it, mint another; rotation
  supports a configurable overlap window so redeploying the new value is
  never a race against the old one stopping).
- `p_customer_id` is **never** accepted from anything the workflow itself
  authored — every RPC resolves it from the row the token-gated caller is
  actually touching, the same discipline documented at length in
  `docs/automations.md`'s security review.

This is why hitting `/api/cron/automations` (or the opportunistic path)
without `AUTOMATION_WORKER_TOKEN` configured fails **before a single
database query runs** — `getWorkerToken()` (`engine.ts:97-106`) checks the
environment variable is present and at least `MIN_WORKER_TOKEN_LENGTH`
(**32**) characters long, synchronously, and throws `WorkerNotConfiguredError`
immediately if not. No token, no client, no call — by construction, not by
convention.

---

## 8. Idempotency: why retries and re-fires can't double-act

Two different mechanisms, for two different kinds of repeat:

- **The outbox's own retry** (`attempts`/`claim_token`/stale-claim recovery,
  §2–§5) protects against a *worker* re-running the same event — a crash
  mid-processing, a timeout, an explicit retryable failure.
- **`automation_key`**, a deterministic, unique key computed per
  (`automation_id`, triggering event, and — for a node-referenced
  Update/Deactivate — the referenced node's own id), protects against a
  *side effect* being applied twice even if the same logical action somehow
  runs twice (e.g. a retried event re-executing a Create Task action that
  already succeeded last attempt). Every write RPC checks this key first,
  before any allowlist check or column write, and reports `duplicate`
  rather than writing again.

These compose: the outbox guarantees an event is worked on by at most one
worker at a time (never zero, eventually, given retries); `automation_key`
guarantees that even a legitimate retry of the *same* event can't
double-create or double-update a record.

---

## 9. The safeguard constants, in one place

All of the following live in `features/automations/config/safeguards.ts` —
the single place a new numeric limit is ever added, per this feature's own
rule against a hardcoded number anywhere else:

| Constant | Value | Bounds |
|---|---|---|
| `EVENT_BATCH_SIZE` | 25 | Rows one `claim_automation_events` call takes |
| `PROCESSING_TIMEOUT_SECONDS` | 300 | How long a claim is honored before stale-claim recovery reclaims it |
| `MAX_RETRIES_PER_EVENT` | 3 | Attempts before an event goes `dead` |
| `MAX_WORKFLOW_DEPTH` | 3 | How deep an automation-triggers-automation chain may go |
| `MAX_ACTIONS_PER_EVENT` | 10 | Total actions one event's whole lineage may execute, across every automation and every Loop iteration |
| `MAX_LOOP_ITERATIONS` | 50 | A single Loop step's own ceiling, independent of (and always tighter than or equal to) the budget above |
| `MAX_RECORDS_PER_QUERY` | 200 | Rows a single Get Records call may return, clamped server-side in SQL, not just requested |
| `MIN_WORKER_TOKEN_LENGTH` | 32 | Minimum accepted length for `AUTOMATION_WORKER_TOKEN` |

---

## 10. What today's session actually changed here

Diagnosed a real event stuck at "1 waiting to be processed, never run" on a
local `next dev` server:

1. `AUTOMATION_WORKER_TOKEN` was unset in `.env.local` — confirmed by
   listing the env file's own keys, and reproduced live by calling
   `GET /api/cron/automations`, which returned `503 {"status":"not_configured"}`
   instantly (before any database round trip, per §7's fail-fast design).
   This is why the opportunistic path had already fired and already failed,
   silently from the UI's perspective but correctly `console.error`'d every
   time.
2. The error message that `WorkerNotConfiguredError` carried was itself
   wrong — it told an operator to `select token from public.automation_worker_config`,
   a column that has never existed (§7 explains why: only a hash is ever
   stored). Fixed to point at `rotate_automation_worker_token()`, matching
   `docs/automations.md`'s own setup instructions and the security test that
   already asserts no plaintext column exists (`test/db/review.mjs`).
3. Added the dev-only manual trigger described in §6c, closing the gap that
   local development has neither `after()`'s single opportunistic shot (once
   spent, it's spent) nor cron (never runs locally at all).

None of this touched `claim_automation_events`, `complete_automation_event`,
the executor registry, or any safeguard — the queue mechanics described
above were sound throughout; the gap was purely in configuration
(the token) and in operator-facing text (the error message and the missing
local retry path).
