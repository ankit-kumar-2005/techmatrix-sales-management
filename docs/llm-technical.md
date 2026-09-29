# LLM integrations — the technical mechanics

Every place this app calls a large language model, in one document: the shared
transport, each feature's own prompt/schema/model chain, the assistant's full
request lifecycle (its biggest consumer), and — just as important — the parts
of "AI assistant" that are **not** LLM calls at all (voice input, record
lookup, the write path). Companion reading: `docs/automationtechnical.md` for
the event-processing engine automations *run inside*, which is a different
system from the AI that can *draft* an automation (§3.4 below).

Everything here is backed by real code, cited by file and line. Nothing in
this document is aspirational.

---

## 1. The one thing every LLM call in this app has in common

**No LLM output is ever trusted to authorize or perform a database write by
itself.** Every feature below either:

- returns a **draft** that a human reviews and explicitly submits through an
  existing, unmodified, already-authorized Server Action (Leads' AI creation,
  the automation builder, Meeting Notes, the assistant's create/edit flows), or
- produces **read-only prose** built entirely from data the caller already
  fetched through the app's normal, RLS-respecting query path, with no query
  of its own (the assistant's summarize path).

A model is never given a database credential, a tool, or a function to call.
It receives a prompt, returns JSON, and that JSON is validated by a Zod schema
before a single field of it is read. Nothing about role, tenant, or RLS
authorization is ever decided by a model's output — see §6.

---

## 2. The shared transport: `lib/ai/openrouter.ts`

Six feature modules independently talk to OpenRouter. Five of them share one
generic chain-walker; Meeting Notes keeps its own (§2.3 explains why).

### 2.1 `runStructuredCompletion<T>()` — the chain-walking algorithm

`lib/ai/openrouter.ts:151-186`. Given a system prompt, a user message, a Zod
schema, and an ordered `chain` of model ids, it walks the chain until one
model returns JSON matching the schema:

```
for each model in chain:
    attempt (no reminder)
    if ok:                     return it
    if parse_failed:           attempt again (WITH "Return ONLY the JSON object" reminder)
        if ok:                 return it
    move to next model in chain
every model exhausted → { ok: false, reason: "all_tiers_failed", attempts }
```

The rule that decides "retry the same tier" vs. "move to the next tier" is
the one piece of judgment in the whole loop (`attemptOnce`,
`lib/ai/openrouter.ts:193-296`):

| Outcome | What happened | Response |
|---|---|---|
| `parse_failed` | Valid HTTP 200, but the content wasn't valid JSON, or was JSON in the wrong shape | Retry the **same** model once, with a "JSON only" reminder appended as a second system message |
| `tier_failed` | Network error, timeout, non-2xx HTTP, empty/`null` content | Move straight to the **next** model — a reworded prompt cannot fix a 429, a timeout, or a reasoning model that burned its whole token budget on hidden reasoning and returned `content: null` |

No caller ever sees a thrown exception from this function — it always
resolves to a discriminated union (`StructuredCompletionResult<T>`,
`lib/ai/openrouter.ts:122-124`), so "every tier failed" is just another
value a caller has to handle, not a crash.

### 2.2 The supporting pure functions

- **`parseChain(configured, fallback)`** (`lib/ai/openrouter.ts:57-63`) — a
  comma-separated env override, or the compiled-in fallback array. Every
  feature below calls this with its own env var name and its own fallback
  chain — see §4's shared-config warning for why the env var name matters.
- **`stripJsonFence(text)`** (`lib/ai/openrouter.ts:116-120`) — strips a
  markdown JSON code fence if the model wrapped its output in one despite
  being told not to. The single most common way an otherwise-correct
  response fails `JSON.parse` in practice.
- **`describeErrorBody(body)`** (`lib/ai/openrouter.ts:81-107`) — turns
  OpenRouter's own error envelope into one safe diagnostic line
  (`provider=... provider_code=... message="..."`) for logs, reading only
  fields that describe the *provider's* rejection — never our request,
  never the prompt, never the Authorization header.
- **`JSON_ONLY_REMINDER`** — the literal string appended as a second system
  message on a reminder retry, kept separate from each feature's own system
  prompt so that prompt stays byte-identical to whatever specification wrote
  it.

### 2.3 Why Meeting Notes has its **own** copy of this walk

`features/meeting-notes/lib/openrouter.ts:1-29`. Meeting Notes shipped first
and had this logic before the shared module existed. It was **not** migrated
onto `runStructuredCompletion`, deliberately: three things about its own walk
are not generic —

1. it distinguishes `image_tiers_unavailable` from `all_tiers_failed` (only
   meaningful for a feature that accepts images);
2. it tracks **which tier** served the response, for `resolveTierForModel()`
   (`features/meeting-notes/lib/openrouter.ts:571-574`) — the Meeting Notes
   list shows "via tier 2" on a card;
3. its failure strings are a **contract**: `describeAllTiersFailed()` in
   `features/meeting-notes/actions.ts` pattern-matches exact substrings like
   `"rate-limited (429)"` to decide what to tell the user. Rewriting the walk
   whose log strings another module parses is not a safe refactor to do
   opportunistically.

The four *pure, stateless* helpers (`describeErrorBody`, `parseChain`,
`stripJsonFence`, `JSON_ONLY_REMINDER`, plus the `ChatCompletionResponse` type)
were byte-identical between the two modules and **are** shared — Meeting
Notes imports them from `lib/ai/openrouter.ts` too
(`features/meeting-notes/lib/openrouter.ts:3-10`). Only the walk itself
(`attempt()`/the `for` loop in `extractMeetingNotes()`) stays local.

---

## 3. Every integration point, at a glance

| # | Feature | Module | Purpose | Writes anything itself? |
|---|---|---|---|---|
| 1 | AI Assistant — chat | `features/assistant/lib/classify-intent.ts` | Turn one chat message + history into an intent, extracted fields, and a record reference | No — never |
| 2 | AI Assistant — bulk summarize | `features/assistant/lib/summarize-records.ts` | Aggregate prose for "summarize all my X" only | No — never |
| 3 | Leads — AI-assisted creation | `features/leads/lib/extract-lead.ts` | Extract a lead draft from a pasted transcript/email | No — hands a draft to the existing New Lead form |
| 4 | Automations — AI builder | `features/automations/lib/generate-workflow.ts` | Turn plain English into a workflow definition draft | No — hands a draft to the same save/activate steps a hand-built workflow uses |
| 5 | Meeting Notes | `features/meeting-notes/lib/openrouter.ts` | Extract title/attendees/summary/action items from text or an image | No — every action item still needs a human-picked lead + assignee before it becomes a task |

Every row uses the **same underlying endpoint**
(`https://openrouter.ai/api/v1/chat/completions`,
`lib/ai/openrouter.ts:39`) and the same request shape: one system message
(the rules), one user message (the untrusted input), `temperature: 0.1`,
`response_format: { type: "json_object" }`, `cache: "no-store"`. There is
exactly one OpenRouter endpoint left in this codebase — see §5 for the one
that was removed.

---

## 3.1 AI Assistant — intent classification (`classify-intent.ts`)

The entry point for every typed, pasted, or voice-transcribed chat message
(`features/assistant/lib/classify-intent.ts:308-328`). One call classifies
**everything** in one shot: which of eight intents (`create_lead`,
`create_task`, `create_contact`, `edit_lead`, `edit_task`, `edit_contact`,
`summarize`, `unclear`), which fields were stated, whether a record reference
was given, and whether the message is a bare back-reference ("edit this").

- **Chain** (`classify-intent.ts:118-123`, override env `OPENROUTER_MODEL_CHAIN`):
  `google/gemma-4-26b-a4b-it:free` → `google/gemma-4-31b-it:free` →
  `cohere/north-mini-code:free` → `nvidia/nemotron-3-ultra-550b-a55b:free`.
  Tier 3 was originally `nex-agi/nex-n2.5-mini:free`, retired from
  OpenRouter's own catalogue (a live HTTP 404) and replaced after verifying
  the two replacements on two *different* providers than the Google-AI-Studio
  tiers 1–2 share, so a single Google outage can't take out the whole chain.
- **Output shape**: a discriminated union on `status`
  (`NEEDS_CLARIFICATION` | `READY`) — see `types/assistant.ts`'s
  `AssistantResponse` and `schemas.ts`'s `assistantResponseSchema`. `fields`
  is one flat, mostly-nullable bag covering every intent's possible fields
  (including `stage`, added this session — see §4.4).
- **What the model is explicitly forbidden from doing** (its own system
  prompt, rules 1–14): invent a fact not present in the conversation; guess a
  database id (`record_reference` is a **name/phrase**, resolved against real
  records only in code — see §4.2); guess a WhatsApp number; guess a stage
  the user didn't name; treat a clarifying answer as a brand-new, unrelated
  message.
- **What never reaches the model**: a bare greeting or help request
  (`"hii"`, `"can you help me"`) is caught **before** this function is ever
  called, by `detectGreetingOrHelp()` (`features/assistant/lib/detect-greeting.ts`)
  — a plain regex match against the whole trimmed/lowercased message, not an
  LLM call at all. This exists because a low-information message like a bare
  greeting gave the model no signal to produce the newer, required
  `refers_to_last_discussed` field correctly, and every tier failed Zod
  validation for exactly that reason on a live message. Removing this whole
  category of input from ever reaching the model removed the failure mode at
  its root, rather than teaching the prompt to handle one more edge case.

## 3.2 AI Assistant — bulk summarization (`summarize-records.ts`)

**The only LLM-authored prose left in the assistant, and only for one narrow
case.** `features/assistant/lib/summarize-records.ts:1-31`. A "summarize"
request that resolves to **one specific record** (or a short list) never
reaches this module at all — see §4.3: that path is 100% deterministic,
LLM-free, by design. This module runs **only** for "summarize all my leads"
— a genuine many-record aggregate overview, which is a synthesis task an LLM
is actually suited for.

- **Chain**: same four-tier `DEFAULT_CHAIN` as classify-intent.ts (same env
  var, `OPENROUTER_MODEL_CHAIN` — see §4).
- **The two bugs this exists to have already fixed before the model ever
  sees the data** (`summarize-records.ts:1-31`, and see §4.4): every lead's
  `deal_value` arrives **already formatted** as a real ₹ string (this app's
  own `currencyFormatter`, never a bare number), and its `stage` arrives as a
  real, resolved stage **name** (never a raw id). The system prompt
  explicitly tells the model both are already final, display-ready text and
  must be echoed exactly — never reformatted, never given a different
  currency symbol (`summarize-records.ts:66-90`, rule about `deal_value`/
  `stage`). This is defense-in-depth for the one summarize surface that
  still touches an LLM at all, after the same two bugs were fixed at the
  root for the single-record path (§4.3) by removing the LLM from it
  entirely.

## 3.3 Leads — AI-assisted creation (`extract-lead.ts`)

Paste a call transcript or email; get a `LeadFormDefaultValues`-shaped draft
back that pre-fills the **existing, unmodified** New Lead dialog
(`features/leads/lib/extract-lead.ts:1-86`, `features/leads/actions.ts`'s
`createLeadAction` is untouched by this feature).

- **Chain** (`extract-lead.ts:88-92`): `google/gemma-4-26b-a4b-it:free` →
  `google/gemma-4-31b-it:free` → `nex-agi/nex-n2.5-mini:free` — this one
  **still uses the retired tier-3 model** (see §3.1's own note that this id
  now 404s on OpenRouter's catalogue); it was flagged in this app's own
  history as a known, not-yet-applied fix for this specific file.
- **The only two fields that can force a clarifying question**:
  `contact_name` and `phone` — because the destination form cannot actually
  be saved without either one (`extract-lead.ts:60-85` walks through the
  live-tested reasoning, including a ~33% observed miss rate on a
  country-code phone number from the weakest fallback tier). Every other
  field (company, email, deal value, source, next step) is left `null` if
  unstated — no question asked, matching how a human leaves a blank form
  field.
- **Never asked of the model at all**: `customer_id`, `owner_id` (both
  always derived server-side from the caller's own session, exactly as for a
  manually typed lead), `stage_id` (an operational choice, not an extractable
  fact — the blank form leaves it unselected either way), and any WhatsApp
  number (a phone number must never be assumed to also be a WhatsApp one).

## 3.4 Automations — AI workflow builder (`generate-workflow.ts`)

Turns a plain-English description ("when a lead's deal value is over 50000
and source is IndiaMART, assign it to Priya and create a follow-up task") into
a `WorkflowDefinition` **draft** — never saved or activated by this function
itself (`features/automations/lib/generate-workflow.ts:212-306`).

- **Chain** (`generate-workflow.ts:52-56`): same three-tier chain as
  extract-lead.ts, same shared `OPENROUTER_MODEL_CHAIN` env var.
- **The prompt is *built from* the capability registry, not hand-written**
  (`buildSystemPrompt()`, `generate-workflow.ts:106-209`) — every trigger,
  condition, action, its config fields, and its limitations come from
  `REGISTRY_ENTRIES` (`features/automations/registry/definitions.ts`), the
  exact same source the workflow builder's own UI palette reads. Adding a new
  action to the registry teaches the model about it automatically; there is
  no second prompt document to remember to update, and no way for the prompt
  to describe a capability that doesn't actually exist.
- **The model never sees a real id.** Team members are passed as opaque refs
  (`member_1`, `member_2`, …) paired with a display name
  (`buildTeamOptions()`, `generate-workflow.ts:390-404`); `translateConfig()`
  (`generate-workflow.ts:319-338`) maps a ref back to a real
  `customer_users.id` **after** the response comes back, server-side, from a
  directory the caller already resolved from its own session. A ref the
  model invents resolves to `null` and is dropped — it cannot name a person
  outside the tenant, because no real id was ever in the prompt to begin
  with.
- **An unknown `type` refuses the whole generation, not just that node**
  (`getRegistryEntry()` check, `generate-workflow.ts:250-259`) — this *is*
  the registry acting as an allowlist, not a filter layered on top of one
  that could drift out of sync.
- **The gate every draft still has to pass**: `validateWorkflow()`
  (`generate-workflow.ts:286-297`) — the **identical** function a hand-built
  workflow is validated against, with no flag or argument that could soften
  it for an AI-generated one.
- **Three response shapes, never mixed**: `READY` (a usable draft),
  `NEEDS_CLARIFICATION` (something subjective like "urgent" or "a big lead"
  was mentioned — the model is told explicitly it cannot decide what that
  means), or `UNSUPPORTED` (the request needs a capability that doesn't
  exist yet — the model is told to say so, never to substitute the nearest
  thing it does have).

## 3.5 Meeting Notes (`features/meeting-notes/lib/openrouter.ts`)

Extracts a title, date, attendees, a summary, and a list of action items from
either pasted text or an **image** (handwritten notes, a whiteboard photo, a
screenshot) — the one feature in this app whose LLM call is multimodal.

- **Two separate chains**, resolved by input kind (`resolveModelChain()`,
  `openrouter.ts:144-148`):
  - **Text** (env `OPENROUTER_MODEL_CHAIN` — shared with §3.1/3.2/3.3/3.4,
    see §4's warning): the same three-tier Gemma/Gemma/nex-n2.5-mini chain.
  - **Image** (env `OPENROUTER_IMAGE_MODEL_CHAIN`, its own separate override):
    `nex-agi/nex-n2.5-pro:free` → `google/gemma-4-26b-a4b-it:free` →
    `google/gemma-4-31b-it:free` — tier 1 deliberately a *different provider*
    (Nex AGI, not Google AI Studio) than tiers 2–3, which share one Google
    rate limit, so a Google outage doesn't take out the whole image chain at
    once. `openrouter.ts:74-137` documents every model actually tested for
    this chain and why each rejected candidate failed (real HTTP 400s,
    timeouts, a model that doesn't exist in the catalogue at all) — a record
    worth reading before adding a new candidate rather than re-testing
    something already ruled out.
- **A suggested assignee is a literal name, never an id** — the model reads
  a name out of the notes; `features/meeting-notes/lib/match-assignee.ts`
  resolves it against the caller's own real team directory **in code**,
  after the model call, the same "never let the model pick a real id"
  pattern §3.4 uses for automations and §4.2 uses for the assistant.
- **The image itself is never stored** — a data URL is sent inline in the
  request and never persisted (`openrouter.ts:329-335`'s own note on the
  "text-only v1" decision this deliberately reversed for images, while still
  keeping the binary out of the database).

---

## 4. The assistant's own architecture (the largest consumer)

This is the newest and largest LLM-touching subsystem, built up over several
rounds. One entry point, `sendAssistantMessageAction()`
(`features/assistant/actions.ts:347`), handles every chat turn:

```
user message
     │
     ▼
detectGreetingOrHelp()  ─── match ──▶ GREETING_REPLY (no LLM call at all)
     │ no match
     ▼
classifyIntent()  (§3.1 — the ONE LLM call every other turn makes)
     │
     ├─ NEEDS_CLARIFICATION / "unclear" ──▶ ask the question, nothing else
     │
     ▼ READY
resolveRecordReference() / resolveForSummaryCards()
  (fuzzy-match the model's TEXT reference against REAL records —
   never an LLM call, see §4.2)
     │
     ├─ intent = summarize, ONE record or a short list found
     │     └─▶ AssistantRecordCard[] (clickable) → click →
     │         getRecordDetailAction() → format*Summary() (§4.3, NO LLM)
     │
     ├─ intent = summarize, NO reference at all ("summarize all my leads")
     │     └─▶ summarizeLeads/Tasks/Contacts() (§3.2 — the ONLY other LLM call)
     │
     └─ intent = create_*/edit_*
           └─▶ AssistantPendingAction (inline confirmation card, §4.5)
               OR a formTrigger (open the real dialog) when something
               genuinely needs a human decision the model can't safely default
                     │
                     ▼ user clicks Confirm
               confirmAssistantActionAction()  (§4.5 — NO LLM, ever)
                     │
                     ▼
               the EXACT SAME createLeadAction/updateLeadAction/
               createTaskAction/updateTaskAction/createContactAction/
               updateContactAction a manual Save button already calls
```

**Only two of this whole diagram's boxes ever call an LLM**: `classifyIntent`
and the bulk-summarize branch. Every other box — reference resolution,
single-record summaries, stage-name lookup, currency formatting, and the
entire write path — is plain, deterministic TypeScript.

### 4.1 Voice input is not on this diagram at all

`features/assistant/components/use-voice-recorder.ts` turns speech into the
same typed `message` string `sendAssistantMessageAction` already accepts —
**entirely client-side, via the browser's own `SpeechRecognition`/
`webkitSpeechRecognition` API (the Web Speech API), never OpenRouter, never
any server, and at zero cost.** This replaced an earlier version that
recorded audio with `MediaRecorder` and uploaded it to OpenRouter's paid
`/api/v1/audio/transcriptions` (Whisper) endpoint — the one non-free AI call
this app ever made. That endpoint, its dedicated module
(`features/assistant/lib/transcribe-audio.ts`), and the Server Action that
received the upload (`transcribeAssistantAudioAction`) have all been removed
outright; see §5.

By the time transcribed text reaches `sendAssistantMessageAction`, there is
no way to tell it came from a microphone rather than a keyboard — voice is
purely an alternate way to *produce* the same string, never a separate
reasoning path (this is a standing design rule across every input method the
assistant accepts).

### 4.2 Reference resolution is deterministic, never a second LLM call

`features/assistant/lib/resolve-reference.ts`. The model's job stops at
producing a free-text guess (`record_reference: "kiran pande"`) — it never
sees the customer's actual records and is never asked to match against them.
`resolveReference()` does that matching **in code**, against records the
caller already fetched through the app's normal RLS-respecting query path
(`fetch-records.ts` — see that module's own header for why this is
`getLeadsForCustomer`/`getTasksForCustomer`/`getContactsPage`, never
`get_automation_records()`, which is a worker-token-authorized function with
no per-caller visibility filtering). A normalized substring/word-overlap
check (`resolve-reference.ts:22-47`), deliberately not a fuzzy-matching
library — the same "roll your own, transparent, no surprising edge cases"
reasoning the Contacts duplicate-detection feature already established. Its
only three outcomes — `none` (ask), `one` (proceed), `many` (list the real
candidates and ask) — are all safe; there is no silent-pick failure mode.

### 4.3 Single-record summaries are 100% LLM-free — the bug fix this session made permanent

`features/assistant/lib/format-summary.ts`. A "summarize Kiran Pande" request
used to hand the model Kiran's raw record as JSON and let it write a prose
paragraph — which is how two real bugs got in: the model was never told the
real stage name (only an opaque `stage_id` it had no way to resolve), and a
bare unlabeled number for `deal_value` let a model default to its own
training bias for currency (`$99,999.88` instead of ₹). Both are now
structurally impossible, because there is **no LLM in this code path
anymore**:

- `formatLeadSummary()`/`formatContactSummary()`/`formatTaskSummary()`
  (`format-summary.ts:72-128`) build a labeled-field string directly from the
  real record.
- The stage name comes from `fetchStageName()`
  (`features/assistant/lib/fetch-records.ts:173-176`) — the exact same
  `getLeadStagesForCustomer` lookup Pipeline and the stage-color system
  already use, never a second mapping.
- The currency comes from `currencyFormatter` (`utils/format.ts`) — the
  identical `Intl.NumberFormat("en-IN", …)` instance every KPI card, Pipeline's
  Value column, and the Forecast page already use.
- Related Contacts/Tasks for a lead come from `getContactsForLead`/
  `getTasksForLead` — the same RLS-respecting `supabase` client every other
  query in this app uses, added directly to the canonical
  `features/contacts/lib/get-contacts.ts`/`features/tasks/lib/get-tasks.ts`
  files rather than a parallel query mechanism.

A lookup that resolves to one record (or a short list) surfaces each as a
clickable `AssistantRecordCard` in the chat; clicking one calls
`getRecordDetailAction()` (`actions.ts:1062`), which re-fetches the record
fresh (never trusting the client-supplied id blindly) and builds its summary
through the functions above. No model call happens anywhere in this path.

### 4.4 The one field added specifically to make a stage change expressible

`AssistantFields.stage` (`types/assistant.ts`) — a free-text stage **name**
("Qualified", "Won"), extracted by `classify-intent.ts` only for `edit_lead`,
only when the user is clearly asking to move a lead's pipeline stage. Before
this existed, the assistant had **no representation of a stage change at
all**. Resolution is identical in spirit to `record_reference` (§4.2): the
model never sees or produces a `stage_id`; `sendAssistantMessageAction`
resolves the stated name against this customer's real, current stages via
the same `resolveReference()` fuzzy-match-or-ask mechanism, using only Active
stages plus whichever stage the lead is already on (matching
`LeadFormFields`' own selectable-stages rule).

### 4.5 Create/edit: an inline confirmation card, never a model-authorized write

`AssistantPendingAction` (`types/assistant.ts`) is what a create/edit turn
returns instead of immediately opening the real dialog. It carries:

- **`fields`** — for a create, every field that will be saved; for an edit,
  **only** what's actually different, as a before → after pair (e.g. "Stage:
  Qualified → New") — never a full-record dump.
- **`payload`** — the exact `FormData` entries the real dialog's own Save
  button would submit, built entirely from already-resolved, already-typed
  data (never raw model text passed straight through).
- **`editFallback`** — the exact same dialog-opening `formTrigger` this
  feature already used before inline cards existed, for "Edit instead".

Clicking **Confirm** calls `confirmAssistantActionAction()`
(`actions.ts:1202`) — the **only** function in this entire feature that
writes to `leads`/`tasks`/`contacts`, and it contains no LLM call, no new
validation, and no new authorization logic of its own. It rebuilds a real
`FormData` from `payload` and calls, directly and unmodified,
`createLeadAction`/`updateLeadAction`/`createTaskAction`/`updateTaskAction`/
`createContactAction`/`updateContactAction` — the identical Server Actions a
human's own Save button already calls, with the identical Zod validation,
role checks, and RLS enforcement. `confirmAssistantActionAction` has exactly
one caller anywhere in this codebase: that Confirm button's `onClick`.
**A typed "yes" is just a new chat turn through `classifyIntent` — that
function has no concept of "a card is pending" and no path to this action
at all.**

Some fields have no safe, human-mirrored default and are deliberately never
guessed: a task's due date, or who it's assigned to once a name was actually
mentioned; a brand-new lead's stage falls back to the pipeline's first Active
stage, shown plainly on the card (never hidden) rather than left for the
model to invent. Whenever a genuinely required decision can't be defaulted
this way, the card is skipped and the real dialog opens directly — the exact
behavior this feature always had, never regressed.

---

## 5. What was removed, and why

| Removed | Was | Replaced by |
|---|---|---|
| `features/assistant/lib/transcribe-audio.ts` (whole file) | POSTed base64 audio to OpenRouter's `/api/v1/audio/transcriptions` (Whisper Large V3 Turbo) — the **one paid** AI call in this app | Nothing — no server-side transcription exists anymore |
| `transcribeAssistantAudioAction` (`features/assistant/actions.ts`) | Received the uploaded audio `FormData`, ran the size check, called the module above | Nothing — no audio is ever uploaded |
| `MediaRecorder`-based capture (`use-voice-recorder.ts`) | Recorded a Blob, negotiated a MIME type, uploaded it | The browser's native `SpeechRecognition` API, entirely client-side (§4.1) |

`grep -rn "audio/transcriptions\|whisper\|MediaRecorder" --include="*.ts" --include="*.tsx" .` returns nothing but a historical doc-comment mention — confirmed zero live references remain. This app's LLM cost profile is now **fully free-tier across every integration point** in §3.

---

## 6. Safety invariants enforced across every integration above

1. **Untrusted text always lives in its own user message**, never
   concatenated into the system prompt (every module in §3 states this
   explicitly) — appending it to the system instruction would give a message
   saying "ignore the above rules" the same authority as the rules
   themselves.
2. **Every model output is re-validated by a Zod schema before a single
   field is read.** `runStructuredCompletion`/Meeting Notes' own walker both
   treat a schema mismatch as a retryable failure, never as data to
   partially trust.
3. **A model never sees or produces a real database id.** Team member refs
   (§3.4), lead/task/contact references (§4.2), and stage names (§4.4) are
   all opaque strings or names, resolved against real data **after** the
   model call, entirely in application code.
4. **A model's output never becomes a database write by itself.** Every
   feature in §3 either returns a draft a human must explicitly submit
   through an existing, unmodified Server Action, or produces read-only
   text. See §4.5 for the most elaborate version of this rule (an inline
   *confirmation* card, not a weaker form of confirmation than a button
   click).
5. **RLS, tenant isolation, and role authorization are completely
   independent of, and untouched by, every LLM code path documented here.**
   Every record an LLM is ever shown was already fetched through the
   caller's own normal, RLS-respecting Supabase client before the model call
   happened — see each feature's own "where records come from" note in §3.
   No feature in this document has ever required, and none should ever
   require, a change to a policy, a role check, or a tenant-scoping rule to
   function.

---

## 7. Shared configuration — the one real gotcha

`OPENROUTER_API_KEY` gates **every** integration in §3 identically — unset,
every one of them returns `not_configured` and makes zero requests
(`lib/ai/openrouter.ts:157-160`, `features/meeting-notes/lib/openrouter.ts:487-491`).

**`OPENROUTER_MODEL_CHAIN` is read by five different modules**
(classify-intent.ts, summarize-records.ts, extract-lead.ts,
generate-workflow.ts, and Meeting Notes' own *text* chain) — **setting it
once reconfigures all five simultaneously.** There is no per-feature
override; a chain change intended for one feature (say, retiring a dead
model from the assistant's chat classifier) silently changes lead
extraction, workflow generation, and meeting-notes text extraction too. This
is a real, load-bearing coupling to know about before touching this env var
in any deployment, not an oversight to "fix" quietly — each module's own
compiled-in fallback chain is independently chosen and verified for that
module's own request shape, and an env override bypasses all of them at
once.

`OPENROUTER_IMAGE_MODEL_CHAIN` is the one **separate** override — read only
by Meeting Notes' image path (`features/meeting-notes/lib/openrouter.ts:146`)
— unaffected by the shared variable above.

| Env var | Read by | Effect if unset |
|---|---|---|
| `OPENROUTER_API_KEY` | every module in §3 | `not_configured`, zero requests, everywhere |
| `OPENROUTER_MODEL_CHAIN` | classify-intent.ts, summarize-records.ts, extract-lead.ts, generate-workflow.ts, Meeting Notes (text) | each falls back to its own compiled-in chain |
| `OPENROUTER_IMAGE_MODEL_CHAIN` | Meeting Notes (image) only | falls back to its own compiled-in image chain |

---

## 8. Known limitations, as of this writing

- **Only Meeting Notes accepts an image.** Every other integration in §3 is
  text-in, text-out — the assistant, Leads' extraction, and the automation
  builder have no multimodal path today.
- **Voice input requires Chrome or Edge.** `SpeechRecognition` is not
  implemented in Firefox or Safari; those browsers get a friendly
  "type your message instead" error the moment the mic is clicked, never a
  silent failure (`use-voice-recorder.ts`).
- **Two feature-retired-model gaps exist side by side, deliberately not both
  fixed at once**: `classify-intent.ts` already replaced its own dead tier-3
  model (`nex-agi/nex-n2.5-mini:free`, a live HTTP 404) with two verified,
  differently-provided alternatives; `extract-lead.ts` and
  `generate-workflow.ts` still list the same now-dead id as their own tier 3.
  Each fix was scoped to the feature it was made for, not applied
  app-wide — worth revisiting the moment either of those two features is
  next touched.
