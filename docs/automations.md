# Automations — operations, architecture, and honest limits

Written for: whoever deploys, operates or extends this feature next.

This is the first feature in the app that **creates real business records with
nobody watching**. Everything below follows from that. It is deliberately
written to be useful when something has gone wrong at 3am, so the limitations
section is as long as the setup section.

## What this phase added

The original release supported exactly one trigger (`lead.created`), two fixed
conditions, and one action (`task.create`). This phase turned that into a
configurable, dynamic system without touching that foundation's security model:

- **Record-triggered events** — Created, Updated, or Created-or-Updated, with
  an "only when it starts matching" mode for updates. The `leads` trigger now
  fires on `INSERT OR UPDATE` and snapshots the **whole row**, old and new, so
  a condition can read any allowlisted field without ever needing another
  trigger migration.
- **A dynamic field registry** (`registry/fields.ts`) — 11 Lead fields, typed
  (text/number/date/enum/reference), each with only the operators that make
  sense for its type.
- **A generic AND/OR condition builder** (`registry/condition-group.ts` +
  `components/condition-group-editor.tsx`) — nested groups up to a safe depth,
  replacing "one hardcoded comparison" with a real expression tree, still
  incapable of anything beyond comparing one registry field to a typed value.
- **Update Lead**, a second privileged write (`update_lead_via_automation`),
  allowlisted to next step, deal value, status and owner — and nothing else.
- **A per-node Learn tab**, generated from the same registry the palette and
  validator already read.
- **Server-side pagination on Execution History.**
- **A previously-impossible test made real**: end-to-end loop prevention.
  Building `Update Lead` is what makes a genuine cycle constructible for the
  first time — and building it surfaced a real bug (below) before it shipped.

---

## Automation Studio canvas — Decision, Assignment, and the "+" button

A second round on top of the above, aimed at the BUILDING experience rather
than the execution engine: multi-outcome branching, a temporary-value step,
and a contextual way to extend a workflow without dragging a connection by
hand. All three are **definition-JSON and engine-logic only** — no new
migration, because a Decision or Assignment node is stored exactly like every
other node already was (`kind`/`type`/`config` in the same JSONB column), and
evaluating one is exactly as pure as evaluating a condition already was.

- **Decision** (`registry/definitions.ts`'s `lead.decision`, kind `"decision"`)
  — named, ordered outcomes, each with its own AND/OR condition tree (the
  *same* `ConditionGroup` engine `lead.match` already used — there is still
  only one AND/OR evaluator in this app, not one per node type). Outcomes are
  checked in the order shown; the first match wins; an always-present
  `DECISION_DEFAULT_BRANCH` ("Otherwise") catches everything else. This
  required generalising `WorkflowEdge.branch` from a fixed `"true"|"false"`
  pair to an arbitrary string (an outcome's own id, or `"default"`) — the one
  structural change to the stored shape, and it is purely additive: every
  edge ever saved with `branch: "true"` or `"false"` parses exactly as before.
- **Assignment** (`workflow.assign`, kind `"assignment"`) — computes a named,
  **temporary, in-memory** value (from a lead field or typed text; operators
  Set/Add/Subtract/Append) that later steps on the *same path* can reuse as
  `{{var.name}}` in a task subject/description or Update Lead's "Next step".
  Resolved once, inside `planWorkflow`'s own walk, before an action's config
  ever reaches its executor — by the time `executors.ts` sees a config, every
  `{{var.*}}` token is already a literal string or `""`. This is the same
  closed, fixed-pattern substitution `{{lead.company}}` already used, extended
  with a second, equally closed vocabulary — never an expression language, and
  never anything written to the database. **Scoped per path**: the walk clones
  its variables map at every branch point, so a value set on one decision
  outcome is not visible on a sibling outcome (`plan-workflow.test.ts` has a
  dedicated regression for exactly this).
- **The contextual "+" button** — every node's currently-unconnected output
  (computed live from the edge list, never stored) renders a small "+" chip at
  that exact handle; every edge has a "+" at its own midpoint. Both open the
  same searchable insertion menu (`NodeInsertMenu`, reading the identical
  registry the sidebar palette does) and wire the new node in automatically —
  appended after a specific output, or spliced into the middle of an existing
  connection, preserving the original edge's branch on the segment before the
  new node. Dragging a connection by hand (`onConnect`) still works
  unchanged — the "+" system is additive, not a replacement.
- **Loop is listed, not built** *(as of this phase — since built; see "Phase 2
  expansion" below)*. It appeared in both the palette and the "+" menu as a
  visibly disabled "Coming soon" entry with its reason shown on hover, rather
  than either being silently absent or present-but-fake.
- **Not extended this round**: the AI workflow generator (`generate-workflow.ts`)
  still authors only triggers, `lead.match` conditions, and the two existing
  actions — it does not yet propose a Decision or an Assignment. Teaching it
  to would mean extending the model's own JSON contract and testing that
  contract against real model output, which is separate, real work this round
  did not include; an AI-authored workflow can still be opened and extended
  with a Decision or Assignment by hand afterward.

---

## Task and Contact record actions — targeting, deactivation, and `record_inactive`

This phase extended automation write access beyond Lead to Task and Contact,
without touching either object's existing human-facing RLS or list UI.

**Five new actions**: `Create Contact`, `Update Task`, `Update Contact`,
`Deactivate Task`, `Deactivate Contact` (migration
`20260923120000_task_contact_automation_writes.sql`). Each follows the same
shape `create_automation_task`/`update_lead_via_automation` established: token
gate first, idempotency before any side effect, tenancy re-verified
server-side, an explicit column allowlist, `search_path` pinned. `Create
Contact` mirrors `Create Task`'s own audit — same allowlist/tenancy/
RLS-untouched pattern, verified against real PostgreSQL
(`test/db/review5-task-contact.mjs`, section 3) — resolving the concern the
original "Create Contact — deliberately not built" note (below) raised.

**New columns**: `tasks.activation_status` and `contacts.status`, both
`text not null default 'Active' check (... in ('Active','Inactive'))`.
Deactivation is **one-way** — no code path ever sets either column back to
`'Active'` — and is a normal `UPDATE`, never a `DELETE`; both are structurally
proven in `review5-task-contact.mjs` (no DELETE grant to any API-facing role;
a deactivated record's key can never be matched by a human-created row, since
`automation_key` is populated only on automation-created rows). Deactivation
does **not** change existing RLS — an Inactive record is still fully
SELECT/UPDATE-able through the app exactly as before; deactivation is an
application-level state, not a security boundary. See "Inactive Task/Contact
visibility" under "Extending Automation Studio" for the one approved,
not-yet-built follow-up this implies.

**`record_inactive`**: `update_task_via_automation`/`update_contact_via_automation`
refuse to write to an Inactive record, checked in the same read that already
confirms tenancy, after idempotency (so a retried already-applied write still
reports `duplicate`, not `record_inactive`) but before any allowlist check or
write. `deactivate_*_via_automation` is exempt — deactivating an
already-Inactive record is an idempotent no-op by design, not a rejection.

**Node-reference targeting.** Update/Deactivate Task/Contact never receive a
raw record id — a Lead-triggered workflow has none of its own. Instead each
one names an earlier **Create** node in the *same* workflow (`sourceNodeId`);
at execution time the executor recomputes that node's own deterministic
`automation_key` (the identical `buildAutomationKey` function, substituting
the referenced node's id) and passes it as `p_target_key`, which the SQL
function looks up by `(customer_id, automation_key)`. This reuses the existing
idempotency-key mechanism for a second purpose rather than adding any new
engine state — retry-safe and branch-safe for the same reasons the idempotency
key already was:

- An ancestor Create node is always planned before a descendant node that
  references it (`planWorkflow`'s BFS only enqueues a node after walking an
  edge *from* an already-visited node).
- A failed Create node's dependent Update/Deactivate is never invoked (the
  engine's action loop is sequential and breaks on the first real failure).
- "Multiple matches" is structurally impossible — the unique index on
  `automation_key` guarantees at most one row.
- If the referenced Create node's branch wasn't taken this run,
  `update_*_via_automation`/`deactivate_*_via_automation` returns
  `target_not_found` — treated by the executor as a **benign no-op success**
  (`deduplicated: true`), not a failure, since it represents ordinary
  conditional branching, not a bug. The rest of the automation's actions still
  run.
- A node-reference pointing at a deleted node, the wrong node type, or a node
  no path can reach from it is rejected at **workflow validation**, before
  save (`validate-workflow.ts`'s `isAncestor` check) — never discovered only
  at runtime.

**Registry-driven config.** `TASK_FIELD_REGISTRY`/`CONTACT_FIELD_REGISTRY`
(`registry/task-fields.ts`/`registry/contact-fields.ts`) are the source of
truth for which fields Update Task/Update Contact can touch; both the Zod
schema and the config-panel fields are derived from them, so the UI can never
offer a field the backend won't accept. A blank field means "leave this field
alone" (the same convention `lead.update` already used), translated to `NULL`
before the RPC call.

**Deliberately still not built as of this phase** — since built; see "Phase 2
expansion" below for all three: Task/Contact **triggers**, **Get Records**,
and **Loop**.

---

## Canvas fixes and additions — the edge "+", the Decision diamond, auto-layout, and the field reference picker

**Bug: an edge's own "+" could silently miss a real click.** Root cause,
found by reproducing a real Chromium press-and-hold (not just a synthetic
zero-duration `.click()`, which never showed it): the button's own
`hover:scale-125` + `transition-all` classes made it visibly grow while
the cursor hovered it, and because its position is a JS-computed inline
`transform` (`translate(-50%,-50%) translate(labelX, labelY)`, tracking
the edge's live midpoint), the growing hit-target actually drifted out
from under a cursor that hadn't moved — a real human click, which is
never instantaneous, could land after the target had already shifted.
Confirmed by instrumenting `document.elementFromPoint` across the
mousedown→mouseup window: the element under the cursor changed mid-click
with zero mouse movement. Fix: dropped `hover:scale-*`/`transition-all`
from both this button and the node's own dangling-output "+" chip (which
has the same JS-driven-position shape), keeping a plain colour-only hover
— see `insertable-edge.tsx`'s and `workflow-node.tsx`'s own notes. Nothing
about `nodrag`/`nopan` or event propagation was the cause; both were
already correct.

**The Decision node is now a diamond**, a shape/layout convention only
(no Salesforce colours, icons or terminology) — an SVG `<polygon>`
outline, not a `clip-path`'d div: a border or `ring` on a clipped
rectangle only survives as four near-invisible slivers where the diamond
happens to touch the rectangle it was clipped from (tried first,
confirmed invisible by screenshotting a real render), while an SVG
stroke is drawn along the polygon's own path directly. Each outcome
(including "Otherwise") keeps its own real, independently-connectable
handle and its own "+" — now positioned at the matching point on the
diamond's actual silhouette (`diamondHandlePoint` in `workflow-node.tsx`),
not floating off a plain right-hand edge. The outcome list that used to
sit inside the node is gone — there's no room for one inside a diamond —
and each outcome's name now renders on its own edge instead
(`insertable-edge.tsx`, reading the SAME `label` this app already computed
for every branching edge but never actually rendered).

**Auto-layout** (`lib/auto-layout.ts`, `@dagrejs/dagre`, `rankdir: "LR"`)
is a new toolbar button, not something that runs silently on every edit —
a manual drag is never overwritten until it's clicked again. It exists
because a Decision's outcomes can now diverge and later reconverge onto
one shared downstream node, which the old fixed-column placement
(`addNode`'s own heuristic) never had to arrange around; reconvergence
itself needed no engine change — `validateWorkflow`'s cycle check is a
proper 3-colour DFS that already treats a diamond (two paths sharing a
descendant) as fine, only a genuine back-edge as a cycle, and
`planWorkflow`'s BFS already visits a node at most once however many
parents lead to it.

**The field reference picker** (`field-reference-picker.tsx`) lets an
admin insert a `{{lead.*}}` token without typing its exact syntax: click
"Insert field" next to a field, pick "Lead" (the one source today,
structured as a list so a future source — e.g. a `Set a variable` value —
costs nothing extra to add), then pick a field. The field list is
`SUBJECT_TOKENS`, which is now **derived from `LEAD_FIELD_REGISTRY`**
(11 fields, every one except the `reference`-typed `owner_id`) instead of
a separately hand-maintained 3-token list — and `renderTemplate` was
widened to match, reading every field except the original three
(`company`/`contact_name`/`source`, which keep their own special
resolution — see `renderTemplate`'s own note on why: those three are
deliberately re-read live at processing time rather than from the
trigger-time snapshot every other field uses, and folding them into the
generic path would have silently made them stale). Wired onto every field
that already renders through `renderTemplate` today: task subject/
description (both create and update), Update Lead's "Next step", and —
newly, to make the picker's promise there actually true rather than
inserting a token that would just sit there literally — a "Set a
variable" static value, which did not call `renderTemplate` before this
change and now does.

---

## Phase 2 expansion — Task/Contact triggers, Deactivate Lead, Get Records, Loop, Resources

This is the largest single expansion since the original engine build. Four
things landed together because the last one (Loop) genuinely needed the
first three to exist first.

### Task/Contact triggers, and Deactivate Lead

Two new outbox triggers — `tasks_enqueue_automation_event`/`contacts_
enqueue_automation_event` (`20260924120000`), byte-for-byte the same shape
`enqueue_lead_automation_event` already was. **No change was needed to
`automation_events`, `claim_automation_events`, or `get_active_automations`**
— `subject_id` was already not a foreign key and `event_type` was already
plain text specifically so a second and third source table could write to
this outbox without a schema change (see that migration's own design
notes). `task.created`/`contact.created` triggers are addable from the
palette today with `eventType`/`updateMode`, the identical shape Lead's
own trigger has — **minus an entry-condition field**, a deliberate, stated
v1 limitation: a condition builder needs a field-registry lookup wired
into `evaluateFieldRule`, and Task/Contact conditions are not built (see
"What is and is not verified" below). A Task/Contact-triggered workflow
can run actions unconditionally today, not yet branch on the triggering
record's own fields.

**A real, easy-to-miss bug this surfaced before it shipped:** the moment
Task/Contact have their own outbox triggers, the SIX existing Task/Contact
automation-write functions (create/update/deactivate × task/contact) can
re-fire those triggers on their own writes — exactly the lineage gap
`update_lead_via_automation` needed fixing for once already (finding #15,
above). All six gained the same three trailing lineage parameters and set
them before their one write, in the SAME migration that added the
triggers, before the gap could ever be exploited. Proven, not assumed:
`test/db/review7-task-contact-triggers.mjs` drives a real Task
self-loop (an Update Task action targeting the very task whose update
triggered it) through claim → evaluate → act → record against live
PostgreSQL, and confirms the ancestry safeguard stops it — not the
8-round bound of the test itself.

Deactivate Lead (`lead.deactivate`) needed no new column — `leads.status`
already existed as one of Update Lead's own allowlisted fields — just a
dedicated, discoverable action matching Task/Contact's own convention,
targeting `context.leadId` directly (never node-reference targeting,
since a Lead-triggered workflow's own lead already is a concrete row).

### Get Records and Loop

**The core design tension, found by reasoning it through before writing
code, not after:** `planWorkflow` is deliberately pure (no Supabase, no
fetch — see its own docstring), but a collection of records can only ever
come from a REAL query. So Loop could not be "unrolled" at plan time the
way a first instinct suggests — the collection it would iterate does not
exist yet when planWorkflow runs. Get Records and Loop are both therefore
ordinary `PlannedAction`s, executed by the EXISTING sequential engine
loop exactly like any other action — no new interpreter, no new execution
model. What's new is `ActionContext.recordVariables`, a `Map` Get Records
writes into and Loop reads from, constructed FRESH per automation's run
against one event (never shared across automations reacting to the same
event, never persisted — see `RecordVariableValue`'s own note in
plan-workflow.ts on why this is narrower-scoped than the existing
`{{var.*}}` scalars, which at least survive across a plan's whole walk).

**Get Records tenant isolation — reasoned through, not just asserted (see
`get_automation_records`'s own design notes in
`20260925120000_get_automation_records.sql`):** `p_customer_id` is never
read from a workflow's stored JSON — only from `context.customerId`,
itself always `event.customer_id`, resolved server-side by
`claim_automation_events`. `p_object` never becomes part of a SQL string
— it is compared with plain `=` against three fixed literals, each
branch a completely separate, hardcoded, already-scoped query; there is
no `EXECUTE`/`format()` anywhere in the function, so there is no path
from `p_object`'s value to a table name, a column name, or another
tenant's row. The scan itself is bounded server-side
(`least(p_limit, 200)`), not just the caller's own request. Proven, not
asserted: `test/db/review8-get-records.mjs` seeds two real tenants with
distinguishable rows, confirms each tenant's query returns exactly and
only its own rows, and throws four classic SQL-injection payloads at
`p_object` directly, confirming each resolves to zero rows (no branch
matches) rather than an error or a leak.

Get Records filters its result with `evaluateFieldGroup` — the identical
AND/OR engine a Decision node already runs, now accepting an optional
field-lookup function (`object-fields.ts`'s `fieldRegistryForObject`) so
it can be pointed at Task/Contact fields too, while every EXISTING caller
(Decision, `lead.match`, a trigger's entry condition) that omits the new
parameter is completely unaffected — no second filter language, and
`ConditionGroupEditor` was generalized the same way (an optional
`fieldRegistry` prop, defaulting to Lead) so Get Records' own filter UI
shows the right fields for whichever object was picked.

**Loop's iteration cap, and how it composes with `MAX_ACTIONS_PER_EVENT`
— reasoned through, then proven with the real executor, not a
simulation:** `MAX_LOOP_ITERATIONS` bounds the loop's own ceiling;
separately, `engine.ts` computes `remainingActionBudget`
(`MAX_ACTIONS_PER_EVENT` minus everything already executed in this
event's lineage, across every automation) before calling ANY executor,
Loop included. Every iteration is checked against that same number
before it runs, and the outcome reports back exactly how many iterations
actually happened (`ActionOutcome.actionsPerformed`, defaulting to 1 for
every other action), so the shared ceiling is charged for the real work
done. Neither limit can bypass the other, because a loop's iterations are
not a separate execution context the existing safeguard cannot see — they
are the identical flat per-event accounting, just several units from one
executor call. `features/automations/registry/executors.test.ts` calls
the REAL `loop`/`getRecords` executors directly (not a reimplementation)
and proves: a collection three times the cap is still capped at
`MAX_LOOP_ITERATIONS`; a small remaining budget stops the loop earlier
than the cap would; a body failure stops the loop immediately (asserted
by exact call count, not just the final status); and Get Records' filter
genuinely excludes non-matching rows using the real `evaluateFieldGroup`
engine.

A Loop's body is exactly ONE step — whichever single action node its own
output connects to on the canvas, not a config field (`planWorkflow`
captures that node's type/config as data inside the Loop's own planned
action, then continues the walk from the body's own downstream edges, so
whatever comes after the loop still runs once — see plan-workflow.ts's
own note). `validateWorkflow` refuses at save time, not discovers at
3am: a Loop with zero or more than one outgoing edge, a body that is not
an action, a body that is itself another Loop (no nesting — a nested loop
would need the SAME plan-time capture applied twice, which
`planWorkflow`'s walk does not do, so it would silently fail at runtime
instead), or a body node anything else on the canvas can also reach.

**Stated v1 limitations, honestly, not silently:** Get Records searches
only the `MAX_RECORDS_PER_QUERY` (200) most-recent rows of the chosen
type, not the whole table — an older matching row beyond that window will
not be found. Loop's body is one step, not a sequence. Neither Task nor
Contact triggers support a condition on their own fields yet.

### The Resources panel

A new tab in the builder's left column ("Add steps" / "Resources"),
alongside the existing palette — not a new place variables live. Every
row is read straight from a real node's own config (an Assignment's
`assignments[].variable`, a Get Records' `resultVariable`, a Loop's
`itemVariable`); there is no separate stored "variable" record anywhere,
matching this app's existing rule that a workflow variable never leaves
the canvas that defines it. "Create a new one directly from this panel"
is the same plain, unconnected `addNode` the sidebar palette already
calls, scoped to the three node kinds that can ever produce a variable.

### Bulk-load and versioning findings (Phase 0, before any of the above was built)

**Versioning already worked exactly to spec** — first save of a new
automation produces version 1, each subsequent save increments by one,
Active or Draft, no code change needed. Confirmed with a real save
sequence against PostgreSQL (`test/db/review6-phase0.mjs`), not just a
read of `saveAutomationAction`'s own code.

**Bulk load**, run against the SAME embedded-Postgres harness every other
DB test in this project uses — not the real IndiaMART webhook, which
would mean sending fabricated pushes at this app's real hosted Supabase
project. 100 real `ingest_lead()` calls, concurrently across 10
connections: 100 leads, 100 `automation_events` rows (one push, one
event, every time), zero duplicates, ~1 second wall-clock. Draining them
— claim, plan, execute, complete — across 4 concurrent workers: 100
tasks created, zero lost, zero duplicated, ~0.5 seconds. No bottleneck
found at this scale; nothing needed fixing before building on top of it.

---

## Required setup, in order

The feature is inert until both of these are done. It fails closed — no
automation runs, nothing is lost, and the reason appears in the server log.

### 1. Apply both migrations, in order

```
supabase/migrations/20260921120000_automations.sql
supabase/migrations/20260922120000_automation_update_triggers.sql
```

The first creates the four core tables, the worker-config table, and the
original `lead.created`-only outbox trigger. The second generalizes that
trigger to `INSERT OR UPDATE`, adds the dynamic old/new snapshot columns, adds
the `automation_action_executions` idempotency ledger, and adds
`update_lead_via_automation`. Both are additive: no existing column,
constraint, policy or row from either is altered or dropped, and the second
migration's `DROP FUNCTION`/`CREATE TRIGGER` pairs replace only what the first
migration itself created.

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
lead created OR updated (Server Action, ingest_lead webhook, or an automation's own write)
   │
   ├─ AFTER INSERT OR UPDATE trigger on leads, in the SAME transaction
   │     → automation_events row: operation, old/new snapshot, changed_fields
   │       (only if some Active automation's trigger_event_type matches)
   │     → inherits the CAUSING event's lineage when this write came from
   │       update_lead_via_automation, else starts a fresh root at depth 0
   │
   ├─ after() on the same request  →  drainAutomationQueue()   ← low latency
   └─ cron, on a schedule          →  processAutomationEvents() ← durability
                                          │
                     claim_automation_events (FOR UPDATE SKIP LOCKED)
                                          │
                     eventType match → depth → ancestry → action budget
                                          │
                     validateWorkflow → planWorkflow (± "entered" double-eval) → executor
                                          │
                     create_automation_task  OR  update_lead_via_automation
                       (SECURITY DEFINER, idempotent, lineage-propagating)
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
| `MAX_CONDITION_GROUP_DEPTH` | how deeply an AND/OR condition group may nest |
| `MAX_CONDITION_GROUP_RULES` | rules or nested groups directly inside one condition group |

**Every safeguard stop is recorded** in `customer_automation_runs` with
`status = 'stopped_by_safeguard'` and a `stop_reason` — enforced by a CHECK
constraint, so a stop cannot be stored without saying which safeguard fired.

### Loop prevention — now genuinely reachable, tested, and (once) broken

`Update Lead` writes to `leads` through an ordinary `UPDATE`, which is what
makes a real cycle constructible for the first time: an automation whose action
leaves its own trigger condition still true can, in principle, re-fire itself
forever. Building this action is what turned loop prevention from "enforced but
unreachable" into something that had to actually work.

**It didn't, on the first pass.** Every event `update_lead_via_automation`
caused looked, to the outbox trigger, identical to an ordinary human edit — a
fresh `root_event_id` at `depth = 0`, every time. `MAX_WORKFLOW_DEPTH` and the
ancestry check both key off exactly those two columns, so neither could ever
see a chain an automation's own writes created. Reproduced empirically before
being trusted: a hand-rolled probe against the real database showed automation
events accumulating indefinitely, each one a disconnected "root", with nothing
stopping it.

**The fix — lineage propagation.** `update_lead_via_automation` now takes the
processing event's own `root_event_id`, `correlation_id` and `depth` as
parameters (the engine already has all three on hand) and sets them as
**transaction-local** settings (`set_config(..., true)`) immediately before its
`UPDATE`. The outbox trigger reads those settings when present and has the new
event inherit that lineage — depth incremented by one — instead of starting a
fresh root. Transaction-local means it is reset at commit and can never leak
into an unrelated statement on a pooled connection; absent entirely for a plain
human edit, which still gets a fresh root exactly as before.

**Now genuinely tested end to end**, not just at the safeguard-function level:
`test/db/review4-loop-prevention.mjs` drives a real self-loop and a real
two-automation A↔B cycle through the actual claim → evaluate → act → record
cycle against live PostgreSQL. Both are caught by the **ancestry** check on
their second pass — before depth ever matters — with the specific stop reason
recorded in `customer_automation_runs` every time. 14/14 assertions pass.

The four decision functions in `lib/safeguards-check.ts` remain unit-tested in
isolation too (`safeguards-check.test.ts`, 14 assertions) — the engine calls
exactly those functions, so both layers describe the same behaviour.

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

Both `create_automation_task` and `update_lead_via_automation` check idempotency
**before** resolving the assignee, so a redelivery cannot burn a round-robin
participant's turn — the same bug `ingest_lead()` documents in its own step 2.

**A third, generic layer** now exists for actions with nothing natural to key
an idempotency check against: `automation_action_executions (customer_id,
automation_key)`. `create_automation_task` has the task row itself to check;
`update_lead_via_automation` mutates an *existing* row, so it has nowhere
equivalent — this small ledger table is that "nowhere", built once, reusable
by any future non-inserting action.

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

A review ran the migration and 226 behavioural assertions (across five test
files) against a real PostgreSQL 18 instance. Sixteen defects were found and
fixed, two of them during this phase specifically. They are recorded
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
| 15 | **`Update Lead` events had no lineage — every one was a fresh root at depth 0.** `MAX_WORKFLOW_DEPTH` and the ancestry check both key off `root_event_id`/`depth`, so an automation whose own write kept its trigger condition true could re-fire itself with no bound the safeguards could see. Found by empirically probing the real execution path, not assumed | **Critical** | Three transaction-local settings carry the processing event's lineage into `update_lead_via_automation`'s own `UPDATE`, read by the outbox trigger. Regression test: `test/db/review4-loop-prevention.mjs`, driving a real self-loop and a real two-automation cycle to a stop (14 assertions) |
| 16 | **`protect_lead_owner_id_change` (a pre-existing trigger) made Update Lead's owner-reassignment permanently non-functional.** It requires `is_customer_admin()`, which reads `auth.uid()` — always NULL for the session-less engine | High | A second, narrowly-scoped bypass condition (`current_setting('app.automation_owner_change', true) = 'authorized'`), set only by `update_lead_via_automation`, transaction-local. Verified NOT to weaken the trigger for anyone else: a bare no-session write and a non-admin session are still refused; only a real admin session or the authorized automation path succeeds |

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

**Verified against a real PostgreSQL 18 instance** (29 migrations applied in
filename order onto a reconstructed Supabase environment — `auth.uid()`, the
`anon`/`authenticated`/`service_role` roles, `storage`), across nine test
files, **378 assertions, 0 failures**:

- Both migrations **apply cleanly**, with no SQL errors.
- **Tenant isolation across two real tenants** with a full role hierarchy
  (ADMIN, MANAGER, SENIOR_SALES_REP, SALES_REP), extended this phase to cover
  `update_lead_via_automation` specifically: cross-tenant automation/lead
  rejected, Draft/Inactive automations refused, negative deal values and
  invalid statuses refused, the allowlist verified by actually checking
  company/contact/email/source/stage_id/customer_id are untouched after a call
  that changes everything else.
- **Genuine concurrency** — two simultaneous connections claiming from a
  20-event backlog: no event claimed twice, all 20 claimed exactly once.
- **Idempotency under a real race**, for both privileged writes: two concurrent
  calls with the same key give one `created`/`updated`, one `duplicate`, exactly
  one row changed either way.
- **Stale recovery and the retry ceiling** — an event dies after exactly
  `MAX_RETRIES_PER_EVENT` attempts.
- **Round-robin, including a SHARED rotation cursor** — verified that
  `create_automation_task` and `update_lead_via_automation` advance the *same*
  `last_assigned_to` cursor when used in the same automation, not two
  independent ones.
- **The record-triggered event pipeline, end to end on a real UPDATE**: a real
  `UPDATE` produces `operation = 'updated'`, correct `old_values`/`new_values`
  snapshots (customer_id/id stripped), and `changed_fields` computed
  generically — including the always-present `updated_at`. A Created-only
  automation gets **zero** outbox rows on an update (the churn-avoidance
  guard); an Updated-only automation gets zero on a create; Created-or-Updated
  gets both.
- **Genuine end-to-end loop prevention** — a real self-loop and a real
  two-automation A↔B cycle, driven through claim → evaluate → act → record
  against live PostgreSQL, both caught by the ancestry check on their second
  pass, both leaving an honest `stop_reason`.
- **The `protect_lead_owner_id_change` fix does not weaken it** — a bare
  no-session write and a non-admin session are both still refused; only a real
  admin session or the token-gated automation path succeeds.
- **Task/Contact record actions** (`test/db/review5-task-contact.mjs`, 76
  assertions) — the schema-level backfill (`NOT NULL` + `DEFAULT 'Active'`,
  confirmed via `information_schema`, not just app behaviour); no DELETE grant
  to any API-facing role on either table; `create_automation_contact`'s full
  token/idempotency/tenancy/eligibility/allowlist audit; `update_task_via_
  automation`/`update_contact_via_automation` targeted by key, including
  `target_not_found` for both a nonexistent key and a cross-tenant one, and
  the shared round-robin cursor with Create Task/Contact; one-way deactivation
  with no partial writes; `record_inactive` rejection scenarios, including the
  proof that a cross-tenant **and** inactive lookup returns `target_not_found`
  — not `record_inactive` — so the tenant boundary never leaks whether a
  record exists; and the idempotency-ordering proof that a retried
  already-used key still returns `duplicate` even after the record went
  Inactive since.
- **Token handling** — hash-only storage, rotation with overlap, immediate
  revocation, and every worker function refusing a wrong token.
- Every SECURITY DEFINER function pins `search_path`; no function is left on
  PostgreSQL's default ACL.
- **Task/Contact triggers and the lineage fix they needed**
  (`test/db/review7-task-contact-triggers.mjs`, 28 assertions) — a real Task
  INSERT/UPDATE and Contact INSERT produce exactly the right event, matched
  by `trigger_event_type`, tenant-scoped, with the churn-avoidance guard
  intact; a real Task self-loop (Update Task targeting the very task whose
  update triggered it) is driven through claim → evaluate → act → record and
  stopped by the ancestry safeguard, not by exhausting the test's own round
  bound; Deactivate Lead's tenancy, idempotency, and one-way behaviour.
- **`get_automation_records` tenant isolation**
  (`test/db/review8-get-records.mjs`, 18 assertions) — two real tenants with
  distinguishable rows, each query returning exactly and only its own
  tenant's data; four classic SQL-injection payloads thrown at `p_object`
  directly, each resolving to zero rows rather than an error or a leak; the
  server-side result cap holding even when an absurd limit is requested.
- **Loop's iteration cap and its composition with `MAX_ACTIONS_PER_EVENT`**
  (`features/automations/registry/executors.test.ts`, a unit test calling the
  REAL executors, not a simulation) — a collection three times
  `MAX_LOOP_ITERATIONS` is still capped at exactly that number; a small
  remaining event budget stops the loop earlier than the cap would; a body
  failure stops the loop immediately, proven by an exact call count; Get
  Records' filter genuinely excludes non-matching rows via the real
  `evaluateFieldGroup` engine.
- **Bulk load at ~100 concurrent leads** (`test/db/review6-phase0.mjs`) — one
  push, one event, every time; zero lost or duplicated leads, events, or
  tasks; ~1.5 seconds total wall-clock for ingest + drain. Run against the
  same embedded-Postgres harness every other DB test here uses, not the real
  IndiaMART webhook (see "Bulk-load and versioning findings" above for why).
- **Versioning** (`test/db/review6-phase0.mjs`) — a real save sequence against
  PostgreSQL produces versions 1, 2, 3, 4 in order, Draft or Active, no gaps.

**Still NOT verified:**

- **Least privilege on function ownership.** Every function is owned by the
  migration runner (`postgres`), so SECURITY DEFINER runs with that role's
  rights — broader than the handful of tables these functions touch. A dedicated
  low-privilege owner role would be tighter. Not done here because creating
  roles interacts with how Supabase manages its own, and it is a deployment
  change rather than a defect.
- **No lead was captured from IndiaMART end to end.** The database half of that
  chain is now proven; the HTTP half needs the user's own IndiaMART account and a
  deployed origin (`APP_URL` is still `localhost:3000`).
- **The AI builder was not called live.** Its output contract is enforced by Zod
  and the registry (including the new field/operator vocabulary given to the
  model); no request reached OpenRouter. It also does not yet author a
  Decision or an Assignment node — see the Studio canvas section above.
- **Delete-triggered automations are not implemented** — see "Extending
  Automation Studio" below for why. (Create Contact, Update/Deactivate
  Task/Contact, Task/Contact triggers, Deactivate Lead, Get Records, and
  Loop all moved off this list across the last two phases — see "Task and
  Contact record actions" and "Phase 2 expansion" above.)
- **Task/Contact triggers do not yet support a condition on their own
  fields** — a stated v1 limitation of this phase, not an oversight; see
  "Phase 2 expansion" above for exactly what would be needed to add it.
- **A visible Active/Inactive filter or status column in the Task/Contact
  list UI is not implemented** — an approved, deliberately deferred follow-up;
  see "Inactive Task/Contact visibility" under "Extending Automation Studio".
- **The Studio canvas's interactive behaviour — dragging a node, clicking a
  "+" chip, the insertion popover, splicing a node into an existing edge —
  was NOT exercised in a real browser.** This environment has no browser
  automation tool available. What WAS verified: the canvas and its new
  components type-check, lint clean, and the production build renders every
  automation route without error; a request to the builder page against a
  running dev server returned a clean auth redirect rather than a server
  crash. The click-through itself — does the "+" chip appear in the right
  place, does the popover close correctly, does a spliced-in node keep the
  workflow visually sane — needs a manual pass before this is trusted the way
  the engine and validator already are.
- The harness reconstructs Supabase's environment rather than being Supabase.
  `auth.uid()` and the roles behave the same way, but RLS on a real Supabase
  project should still be spot-checked after applying.

**Also verified in the application:** TypeScript (clean), ESLint (clean), the
production build (succeeds), and 241 unit tests over the pure logic (up from
211 — the increase is dedicated coverage for Task/Contact trigger matching,
Loop's body capture and validation, and the real `getRecords`/`loop`
executors called directly, not simulated).

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
node test/db/review3.mjs   # record-triggered events, Update Lead, owner-change fix
node test/db/review4-loop-prevention.mjs  # real self-loop + real A↔B cycle
node test/db/exploit-claim-null.mjs  # regression: NULL/state-blind claim ownership
node test/db/review5-task-contact.mjs  # Task/Contact record actions, targeting, record_inactive
node test/db/review6-phase0.mjs  # versioning sequence + ~100-lead bulk load/drain
node test/db/review7-task-contact-triggers.mjs  # Task/Contact triggers, the lineage fix, Deactivate Lead
node test/db/review8-get-records.mjs  # get_automation_records tenant isolation + injection attempts
```

Loop's own iteration-cap/budget-composition logic, and Get Records' filter,
are unit tests instead (no database needed — they call the real executors
directly): `npm test` runs
`features/automations/registry/executors.test.ts` along with everything
else.

`setup.mjs` resets the `public`/`auth`/`storage` schemas and re-applies every
migration each time it runs, so editing a migration and re-running it is safe
without restarting the cluster.

---

## Extending Automation Studio

Every extension point below follows the same shape the existing code already
uses — a new registry entry, not a new mechanism. None of what follows has been
built; each is written the way it would actually need to be done, so a future
change starts from a real plan instead of a guess.

### A new Lead field for conditions

Add one entry to `LEAD_FIELD_REGISTRY` in `registry/fields.ts` — `key`, `label`,
`type`, and `enumOptions` if it's an enum. That's it: the condition builder UI,
`OPERATORS_BY_TYPE`'s type-appropriate operator list, `evaluateFieldRule`'s
type-aware comparison, the AI prompt's field vocabulary, and
`buildFieldsMap`'s allowlist projection all read this one array. **The one
thing that isn't free**: the trigger's `to_jsonb(NEW)` snapshot already
captures every column on `leads`, including ones not yet in the registry — so
adding most new fields needs *no migration at all*, only the TypeScript entry.
`stage_id` is the deliberate exception (see below).

### A field backed by a per-tenant table (the `stage_id` case)

Deferred in this phase specifically because it needs real plumbing the other
fields don't: `stage_id` is a foreign key into `customer_lead_stages`, which is
*per tenant* — there's no fixed, global list of stage names to put in
`enumOptions`. Doing this properly means:

1. A new `FieldDataType` (or an `enumOptions` variant) that says "load these
   options from the database" instead of a static array.
2. Threading the tenant's own stage list from the page load (`AutomationBuilder`
   already receives `team` this way — `stages` would follow the identical
   pattern) down to `ConditionGroupEditor`.
3. The condition VALUE stored in the definition JSON should be the stage's
   **name**, not its id — ids aren't stable across a stage being renamed, and a
   condition should mean "the pipeline stage called X", which survives a
   rename, not "the specific row that today happens to be called X".

### A new action

Add a `RegistryEntry` with `kind: "action"` to `definitions.ts`, and a matching
executor in `executors.ts`. If the action only reads data (no write, no
side-effect), it needs no SECURITY DEFINER function at all — it can query
directly through the session-less client, the same way `get_automation_lead_facts`
already does. If it writes, follow `create_automation_task`/
`update_lead_via_automation`'s shape exactly: token gate first, idempotency
check before any side effect, tenancy and eligibility re-verified (never
trusted from the caller), an explicit column allowlist with no parameter that
could reach anything outside it.

**If the new action's write touches `leads`** (or any table with its own
outbox trigger), it **must** propagate lineage the way `update_lead_via_automation`
does — three transaction-local settings, set immediately before the write, using
the event's own `root_event_id`/`correlation_id`/`depth + 1`. Skipping this is
exactly the critical bug this phase found and fixed (finding #15 above); an
action that can cause a new event and doesn't propagate lineage will make
`MAX_WORKFLOW_DEPTH` and the ancestry check both blind to any loop it causes.

### Find Records / Get Records, and Loop — built (Phase 2 expansion)

This section used to say both needed "a mechanism for one node's output to
become another node's input" that did not exist. It was built, in a
narrower and safer shape than that framing implied: not a general
node-output-binding mechanism, but a single, execution-scoped
`ActionContext.recordVariables` map — Get Records writes a named
collection into it (after a real, tenant-scoped database query
`planWorkflow` itself is not allowed to make), and Loop reads a named
collection back out of it, once per item, up to `MAX_LOOP_ITERATIONS`.
See "Phase 2 expansion" above for the full design, the tenant-isolation
reasoning for `get_automation_records`, and exactly how Loop's cap
composes with `MAX_ACTIONS_PER_EVENT` rather than bypassing it.

Genuinely still not built, and worth keeping honest about: a Loop's body
is exactly one step, not a sequence of several, and Get Records searches
only the most recent `MAX_RECORDS_PER_QUERY` rows of a type, not the
whole table.

### Create Contact — built; the audit this section used to require is done

This subsection previously said Create Contact was deliberately not built
until Contacts' own visibility/hierarchy rules (`features/contacts/`) were
audited against the same "admin-equivalent authority, or something narrower"
question `create_automation_task` and `update_lead_via_automation` had to
answer. That audit happened as part of the Task/Contact record actions phase:
`create_automation_contact` follows the identical allowlist/tenancy pattern,
`contacts.owner_id` is required (no "unowned" contact an automation could
create — the config UI offers no "None" assignment mode, only Fixed/Round
Robin), and RLS on `contacts` was verified untouched. See "Task and Contact
record actions" above and `test/db/review5-task-contact.mjs` section 3.

### Inactive Task/Contact visibility in the list UI — approved follow-up, not yet built

Deactivating a Task or Contact through automation (or, once built, by hand)
does not change either object's RLS — an Inactive record stays fully visible
and editable through the app exactly as an Active one is. Today's list UIs
have no Active/Inactive filter or column, so an Inactive record looks
identical to an Active one there. Approved direction, **not implemented in
this phase**:

- Keep Inactive records visible by default in existing list views — no
  behaviour change to what's already shipped.
- Add an Active/Inactive filter or status column as a separate change, applied
  consistently to both the Task list and the Contact list.
- No reactivation path — deactivation stays one-way everywhere, including
  through this future filter UI.
- The filter/column must respect the same tenant isolation and authorization
  every other list view already enforces — it reads `activation_status`/
  `status` like any other column, through the existing RLS-scoped query; it
  must not introduce a new query path that bypasses it.
- Automation writes are already blocked on Inactive records
  (`record_inactive`, verified in `review5-task-contact.mjs` section 7), so
  there is no risk of an automation silently mutating or resurrecting a
  deactivated record through this UI gap in the meantime.

### Delete-triggered automations — deliberately not built, and the real reason

`leads` has no soft-delete column and no `DELETE` policy or grant anywhere in
this app — every other table follows "deactivate, never delete"
(`customer_lead_stages`, `customer_catalog_items`, `customer_integrations`,
`customer_automations` itself). Building a Delete trigger for leads specifically
would mean inventing a delete path that doesn't exist for leads today, which is
a materially larger, unrelated change — not a natural extension of this
feature.

### Per-customer fairness and quotas — a separate, already-scoped future change

`claim_automation_events` claims globally, `order by e.created_at`, with no
`customer_id` partitioning or per-tenant cap. One tenant with a large backlog
can occupy an entire `EVENT_BATCH_SIZE` on every tick while another tenant's
events wait behind it. Deliberately **not** fixed in this phase, per explicit
instruction not to silently rewrite the scheduler as a side effect of adding
conditions and actions. The shape of a real fix: either round-robin the claim
query across distinct `customer_id`s within a batch, or add a per-tenant cap
parameter alongside `EVENT_BATCH_SIZE` in `safeguards.ts` and filter the claim
CTE by a running per-customer count. Either is a self-contained change to
`claim_automation_events` alone — nothing else in the pipeline needs to change
for it.

### Objects beyond Lead

Task and Contact triggers are BUILT (Phase 2 expansion, above) — `task.created`
and `contact.created`, each with their own `enqueue_*_automation_event` outbox
trigger, lineage-propagating from day one this time (unlike Lead's own first
version, which needed a follow-up fix once Update Lead made a real loop
possible — see finding #15). Task and Contact each also have their own
writable-field registry now (`registry/task-fields.ts`/`registry/
contact-fields.ts`), originally built for Update Task/Update Contact's config
forms and reused as-is for Get Records' filter.

**Still not built**: a condition BUILDER for Task/Contact fields — a Task- or
Contact-triggered workflow can run actions unconditionally, but cannot yet
branch on the triggering record's own fields the way a Lead-triggered one
branches with `lead.match`/Decision. That needs `evaluateFieldRule`
(plan-workflow.ts) wired to know which field registry applies to a given
condition node — the SAME optional-parameter shape Get Records' own filter
already uses (`fieldRegistryForObject`), just threaded through the condition
UI and validation too, which this phase did not do. The registry and engine
architecture do not need further change for this beyond that wiring.
