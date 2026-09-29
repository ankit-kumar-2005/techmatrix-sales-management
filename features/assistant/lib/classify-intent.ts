import { parseChain, runStructuredCompletion } from "@/lib/ai/openrouter";
import { LEAD_SOURCES } from "@/features/leads/schemas";
import { assistantResponseSchema, type AssistantModelResponse } from "../schemas";
import type { AssistantMessage } from "@/types/assistant";

/**
 * The assistant's intent classifier — one LLM call per turn, reusing
 * the SAME shared OpenRouter transport (lib/ai/openrouter.ts's
 * runStructuredCompletion) every other AI feature in this app already
 * uses (Meeting Notes' own chain-walk predates it; the automation
 * builder's generateWorkflow and Leads' extractLead both already build
 * on this exact function). No second OpenRouter integration.
 *
 * THIS FUNCTION NEVER TOUCHES THE DATABASE. It reads the conversation
 * history and the newest message, and returns a classification — which
 * intent, whether it's ready, and a best-effort `record_reference`
 * guess. Resolving that guess against real, tenant-scoped records
 * (features/assistant/lib/resolve-reference.ts) and actually fetching
 * anything (features/assistant/lib/fetch-records.ts) both happen
 * AFTER this call returns, in the caller — this module cannot leak
 * tenant data because it is never given any.
 *
 * PHASE 0 FINDINGS THIS PROMPT IS BUILT FROM — the real required field
 * per object type, confirmed against migrations, not assumed:
 *   - Lead: `contact_name` is `not null` with no default
 *     (20260904140000), never relaxed. `phone`'s own column is
 *     nullable, but createLeadSchema/LeadFormFields require it and —
 *     per direct live testing during that feature's own build — a
 *     free-tier model can silently miss a real phone number often
 *     enough that asking, rather than risking a quiet miss, is the
 *     safer default. These two are the only fields that can force
 *     NEEDS_CLARIFICATION for create_lead/edit_lead.
 *   - Task: `subject`, `lead_id`, `due_date`, `assigned_to` are all
 *     `not null` with no default (20260911120000). `lead_id` is a
 *     REFERENCE to an existing lead, not extractable text — resolved
 *     by the caller via record_reference, never asked about here as a
 *     "fact." `due_date` is deliberately NOT a clarification trigger:
 *     Meeting Notes' own, already-shipped action-item-to-task flow
 *     already leaves an unresolved due date null and lets the
 *     pre-filled form's own required date picker catch it — the same
 *     established precedent applies here, for consistency. `assigned_to`
 *     is NEVER asked about and NEVER set directly by this feature — it
 *     always defaults to the caller in the form; a name mentioned in
 *     the message becomes `assignee_name`, a non-binding hint only
 *     (TaskFormFields' own `assigneeHint`), the exact mechanism Meeting
 *     Notes already established. Only `subject` (and lead_id
 *     resolution) can force NEEDS_CLARIFICATION for create_task.
 *   - Contact: `name`, `lead_id`, `owner_id` are all `not null`
 *     (20260913120000). `lead_id` is resolved the same way as Task's.
 *     `owner_id` is form-required but always defaults to the caller
 *     (createContactAction only forces this for SALES_REP, but the
 *     form itself defaults it to the caller for every role regardless —
 *     this feature never touches it either way). Only `name` (and
 *     lead_id resolution) can force NEEDS_CLARIFICATION for
 *     create_contact.
 *
 * "unclear" is a real outcome: the model is explicitly told that a
 * message with no clear mapping to a supported action must ask what
 * the user wants, never guess an intent.
 *
 * MULTI-TURN CONTEXT FIXES (real transcript, 2026-09-28) — a live
 * conversation exposed two specific gaps in how multi-turn context was
 * handled. Both are fixed here, not by broadly rewording the prompt:
 *
 *   1. A clarifying question and its answer were being evaluated as
 *      two independent messages instead of one combined request — full
 *      history WAS already being sent every turn (confirmed, not
 *      assumed: see formatConversation() below), so the gap was in the
 *      instructions, not the data. Rule 2 now says explicitly: treat
 *      the user's reply to your own immediately-previous question as
 *      completing the ORIGINAL request, and only ask again if
 *      something still genuinely required is missing after combining
 *      everything — never re-ask something already established.
 *
 *   2. "This"/"that"/"it" with nothing else identifying had no way to
 *      resolve at all — asking the model to somehow encode "resolve to
 *      whatever we were just discussing" inside a plain
 *      `record_reference` STRING is exactly the kind of task a small
 *      free model handles unreliably (this was the direct cause of one
 *      observed all-tiers JSON-shape failure). Fixed with REAL
 *      conversation state, not just a prompt instruction:
 *      `refers_to_last_discussed` (rule 5) is a boolean the model sets
 *      when it recognizes a bare back-reference — a language judgment
 *      it's well-suited for — and the caller (actions.ts) resolves
 *      that against `LastReferencedRecord`, tracked, typed client-side
 *      state updated after every turn that unambiguously showed exactly
 *      one record. The model never sees or produces that state; it
 *      only signals whether this message is asking to use it.
 *
 * A related, narrower fix lives in actions.ts: describeAllTiersFailed()
 * now recognizes the one common failure shape above (a genuine
 * parse/shape failure on an edit-plus-bare-pronoun message) and asks a
 * specific clarifying question instead of a dead-end "rephrase" — a
 * defense-in-depth backstop for whenever a request like that still
 * fails classification for any reason, not a replacement for fix #2.
 */

/**
 * Tier 3 was originally `nex-agi/nex-n2.5-mini:free` (matching the
 * chain Leads' own extractLead and the automation builder's own
 * generateWorkflow already use) — replaced here after live testing
 * during this feature's own build (2026-09-26) found it now returns a
 * hard 404 ("No endpoints found"): it has been retired from
 * OpenRouter's catalog since those sibling features last verified it.
 * That breakage is not specific to this module — it affects every
 * existing caller of that same model id — but fixing it there is a
 * separate, deliberate change to already-shipped code this task did not
 * ask for; it's flagged in this build's own report instead. Verified
 * live, right now, against two DIFFERENT providers than the
 * Google-AI-Studio-backed Gemma tiers above (so a Google outage, like
 * the one observed during this same build, doesn't take out every
 * tier at once): cohere/north-mini-code:free (explicitly advertises
 * JSON-schema support) and nvidia/nemotron-3-ultra-550b-a55b:free, both
 * returned valid `response_format: json_object` output on a real
 * request. Overridable via OPENROUTER_MODEL_CHAIN regardless, so a
 * future retirement is a config change, not a deploy.
 */
const DEFAULT_CHAIN = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
] as const;

const MAX_TOKENS = 2000;
const REQUEST_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = `You are the conversational assistant inside a CRM. You read a
conversation between you and a signed-in user and decide what they
want to do with their Leads, Tasks, or Contacts. Return ONLY valid
JSON, no markdown fences, no commentary, matching exactly this shape:

{
  "status": "READY" | "NEEDS_CLARIFICATION",
  "intent": "create_lead" | "create_task" | "create_contact"
           | "edit_lead" | "edit_task" | "edit_contact"
           | "summarize" | "unclear",
  "questions": string[],
  "record_reference": string | null,
  "refers_to_last_discussed": boolean,
  "fields": {
    "contact_name": string | null,
    "company": string | null,
    "email": string | null,
    "phone": string | null,
    "deal_value": number | null,
    "source": string | null,
    "next_step": string | null,
    "subject": string | null,
    "description": string | null,
    "priority": "Low" | "Medium" | "High" | null,
    "due_date": string | null,
    "type": "Call" | "Meeting" | "Email" | "Other" | null,
    "assignee_name": string | null,
    "title": string | null,
    "object": "lead" | "task" | "contact" | null,
    "stage": string | null
  }
}

"refers_to_last_discussed" and "fields" are present only when "status"
is "READY" — omit both entirely for "NEEDS_CLARIFICATION" (send
"questions" instead). Every field in "fields" you don't have a clear
value for must be null; never omit a key.

RULES — READ ALL OF THESE BEFORE ANSWERING.

1. NEVER INVENT A FACT. A name, company, email, phone number, deal
   value, subject, or anything else not clearly present in the
   conversation must be null. If uncertain, use null.

2. A CLARIFYING QUESTION AND ITS ANSWER ARE ONE REQUEST, NOT TWO. If
   your own immediately-previous message in this conversation was a
   clarifying question, the user's new message is the missing piece of
   THAT SAME original request — never re-evaluate it as a fresh,
   standalone message in isolation. Combine the ORIGINAL request with
   EVERY clarification answered since (this may be several turns back)
   to decide the final intent and fields. Ask another question only if
   something still genuinely required is still missing after combining
   everything — never re-ask something the conversation has already
   established, even if the user's literal answer was a single word
   ("Lead", "yes", a bare name). Example: user says "information about
   kiran" (you ask which object type); user replies "Lead" — this alone
   is enough to proceed READY with intent "summarize", fields.object
   "lead", record_reference "kiran". Do not ask a second question
   re-confirming what type of summary they want; the first answer
   already gave you everything.

3. WHICH FIELDS CAN FORCE "NEEDS_CLARIFICATION", PER INTENT — nothing
   else does, so don't ask about anything not listed here:
   - create_lead / edit_lead: only a missing or too-ambiguous
     "contact_name", or a missing "phone" (a phone number is required
     to actually save a lead through this CRM's own form, so ask for
     it the same way you'd ask for the name).
   - create_task / edit_task: only a missing or too-ambiguous
     "subject". Due date, priority, and type are never worth a
     question — leave them null if unstated.
   - create_contact / edit_contact: only a missing or too-ambiguous
     "name".
   - summarize: never about the summary itself — only ask which object
     type (lead/task/contact) when the name given genuinely could be
     more than one type AND nothing else in the message or recent
     conversation already disambiguates it (see rule 8's examples,
     which usually make this unnecessary).
   Ask ONE short, specific question per missing field, never combined
   into one question, and never ask about anything else.

4. "record_reference" identifies an EXISTING record the user is
   talking about — required for edit_lead, edit_task, edit_contact,
   create_task (which existing Lead this new task is for),
   create_contact (same), and optionally for summarize (when
   summarizing one specific record rather than everything). Set it to
   the clearest identifying phrase from the conversation — a name, a
   company, a subject line, whatever the user said — copied close to
   verbatim. You are NOT resolving this against any database yourself;
   you have no access to one. Never invent an id. Never guess a record
   exists if nothing in the conversation names one — leave it null and
   let it be resolved as ambiguous.

5. "refers_to_last_discussed": set to true ONLY when the user
   identifies the record using a bare pronoun or vague back-reference —
   "this", "that", "it", "that lead", "the one you just showed me", "the
   one we were just talking about" — and names NO other identifying
   detail (no name, company, or subject) in that same message. When
   true, leave "record_reference" null; the system resolves it against
   whichever single record was most recently and unambiguously the
   subject of this conversation — you do not need to and cannot know
   which one that is. Set it to false whenever the user names anything
   identifying at all, even something partial ("that Northwind deal",
   "Priya's lead") — those go in "record_reference" as normal, this
   flag is only for a reference with NO name attached to it whatsoever.
   Example: after being shown one lead, the user says "edit this" —
   intent "edit_lead", record_reference null, refers_to_last_discussed
   true.

6. "assignee_name": only for create_task/edit_task, only when a
   PERSON's name is mentioned as who should do the work. A literal
   name as written, exactly like a human typed it — NEVER a database
   id, NEVER invented, NEVER assumed to be the user speaking to you
   themselves unless they say "assign it to me" or equivalent.

7. "source" (create_lead/edit_lead only), if identifiable, must be
   exactly one of these known values: ${LEAD_SOURCES.join(", ")}. If
   the source mentioned isn't clearly one of these, leave it null
   rather than inventing a new value or guessing the closest match.

7b. "stage" — edit_lead ONLY, when the user is asking to move a lead to
    a different pipeline stage ("move this to Qualified", "mark it
    Won", "change the stage to New"). Set it to the stage NAME exactly
    as the user said it — you do not have this customer's real stage
    list and are NOT resolving it against one; that happens
    afterward, in code, against the real list, the same way
    record_reference is resolved. Never invent a stage name that
    wasn't said. null for every other intent, and null for edit_lead
    whenever no stage change was mentioned.

8. COLLOQUIAL PHRASINGS THAT MEAN "summarize" — map these straight to
   intent "summarize" with record_reference set to whatever is named,
   without asking which object type unless genuinely ambiguous (rule 3):
   "information about X", "tell me about X", "what's the status of X",
   "show me X", "how's X doing", "what's happening with X" all mean
   {"intent": "summarize", "record_reference": "X"}. If the rest of the
   conversation already established X's object type (e.g. the user or
   you already said "lead" about X earlier), fields.object is that type
   immediately — do not ask again.

9. NEVER mention, ask about, or populate a WhatsApp number under any
   circumstance — there is no such field in this schema, and a phone
   number must never be assumed to also be a WhatsApp number.

10. "unclear" is a real, first-class outcome. If the message doesn't
    clearly map to creating, editing, or summarizing a Lead, Task, or
    Contact, set intent to "unclear" and status to
    "NEEDS_CLARIFICATION", asking what they'd like to do — never guess
    the closest-sounding intent.

11. The conversation may already contain your own earlier questions and
    the user's answers to them — read the WHOLE conversation before
    deciding; a field or reference answered several turns back is still
    valid context now (see rule 2).

12. "deal_value" is a plain number, no currency symbol or separators.

13. Resolve a relative due date ("by Friday", "next Tuesday", "in two
    weeks") to a real ISO date (YYYY-MM-DD) using the "Today's date"
    given below — the same rule and the same reason Meeting Notes'
    own extraction already follows for a due date. If you cannot
    confidently resolve it, leave "due_date" null rather than guessing.

14. Output must be valid, parseable JSON and nothing else.`;

/**
 * Flattens the whole conversation (the model is stateless between
 * turns) into one plain-text transcript — runStructuredCompletion
 * takes one system message and one user message, not a message array,
 * so the history has to be a single string. Kept in its own clearly
 * labeled block, in the SAME user message as the instruction to
 * classify it — never folded into the system prompt, matching every
 * other AI feature in this app's own "untrusted content stays in the
 * user message" discipline.
 *
 * `todayIso` is resolved server-side by the caller (never from the
 * client), the same reasoning extractMeetingNotes's own todayIso
 * parameter documents — it anchors rule #10's relative-date
 * resolution to a real, trustworthy clock.
 */
function formatConversation(history: AssistantMessage[], newMessage: string, todayIso: string): string {
  const turns = [...history, { role: "user" as const, content: newMessage }]
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n");

  return `Today's date is ${todayIso}.\n\nConversation so far (oldest first):\n${turns}\n\nClassify the user's most recent message above, using the full conversation as context.`;
}

export type ClassifyIntentResult =
  | { ok: true; value: AssistantModelResponse }
  | { ok: false; reason: "not_configured" | "all_tiers_failed"; attempts: string[] };

export async function classifyIntent(
  history: AssistantMessage[],
  newMessage: string,
  todayIso: string = new Date().toISOString().slice(0, 10),
): Promise<ClassifyIntentResult> {
  const result = await runStructuredCompletion({
    systemPrompt: SYSTEM_PROMPT,
    userContent: formatConversation(history, newMessage, todayIso),
    schema: assistantResponseSchema,
    chain: parseChain(process.env.OPENROUTER_MODEL_CHAIN, DEFAULT_CHAIN),
    maxTokens: MAX_TOKENS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    logLabel: "assistant:ai",
  });

  if (!result.ok) {
    return result;
  }

  return { ok: true, value: result.value };
}
