"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership, getNoMembershipRedirect } from "@/features/customers/lib/get-current-membership";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { formatLeadLabel } from "@/features/leads/lib/get-lead-labels";
import { getLeadStagesForCustomer } from "@/features/leads/lib/get-lead-stages";
import { LEAD_SOURCES } from "@/features/leads/schemas";
import { isRealIsoDate } from "@/utils/iso-date";
import { currencyFormatter } from "@/utils/format";
import { TASK_PRIORITIES, TASK_TYPES, type TaskPriority, type TaskType } from "@/types/task";
import type { TaskAssigneeHint } from "@/features/tasks/components/task-form-fields";
import { sendAssistantMessageInputSchema } from "./schemas";
import { classifyIntent } from "./lib/classify-intent";
import { detectGreetingOrHelp, GREETING_REPLY } from "./lib/detect-greeting";
import {
  buildDisambiguationQuestion,
  buildNoMatchQuestion,
  resolveReference,
  type ReferenceResolution,
} from "./lib/resolve-reference";
import {
  fetchContactForEdit,
  fetchLeadForEdit,
  fetchRelatedRecordsForLead,
  fetchStageName,
  fetchTaskForEdit,
  fetchVisibleContacts,
  fetchVisibleLeads,
  fetchVisibleTasks,
  type SummarizableContact,
  type SummarizableLead,
  type SummarizableTask,
} from "./lib/fetch-records";
import { formatContactSummary, formatLeadSummary, formatTaskSummary } from "./lib/format-summary";
import { summarizeContacts, summarizeLeads, summarizeTasks, type PromptableLead } from "./lib/summarize-records";
import type {
  AssistantFormTrigger,
  AssistantMessage,
  AssistantPendingAction,
  AssistantPendingActionField,
  AssistantPendingActionKind,
  AssistantRecordCard,
  LastReferencedRecord,
} from "@/types/assistant";
// The exact, real, unmodified Server Actions the six real dialogs'
// own Save buttons already call — see AssistantPendingAction's own
// header and confirmAssistantActionAction's below for why importing
// and calling these directly (never re-implementing them) is what
// keeps "same underlying write path" true after this feature.
import { createLeadAction, updateLeadAction } from "@/features/leads/actions";
import { initialLeadFormState } from "@/features/leads/form-state";
import { createTaskAction, updateTaskAction } from "@/features/tasks/actions";
import { initialTaskFormState } from "@/features/tasks/form-state";
import { createContactAction, updateContactAction } from "@/features/contacts/actions";
import { initialContactFormState } from "@/features/contacts/form-state";
import type { PipelineLead } from "@/features/leads/lib/get-leads";
import type { Task } from "@/types/task";
import type { ContactListItem } from "@/features/contacts/lib/get-contacts";

/**
 * The assistant's one entry point per chat turn.
 *
 * NON-NEGOTIABLE #1, HOW IT'S ACTUALLY ENFORCED HERE: this function
 * itself STILL never calls createLeadAction/updateLeadAction/
 * createTaskAction/updateTaskAction/createContactAction/
 * updateContactAction, and holds no Supabase write of its own to
 * `leads`/`tasks`/`contacts` anywhere in this file. A create/edit turn
 * now returns, at most, a `pendingAction` — an inline confirmation card
 * rendered in the chat itself (replacing the old "open the real dialog
 * immediately" behavior for the common case) — or, when nothing is
 * safely resolvable without a real human decision (see each case's own
 * comments for when that happens), a `formTrigger` exactly as before.
 * EITHER WAY, the database write itself only ever happens in ONE place:
 * confirmAssistantActionAction below, which does nothing but call the
 * exact same real action a dialog's Save button already calls — or a
 * human clicking that dialog's own Save button directly, via
 * "Edit instead". There is still no third, chat-only write path: a
 * typed "yes"/"confirm" message is just a new chat turn through this
 * same function, which has no notion of "a card is pending" at all and
 * therefore cannot save anything by itself — see AssistantPendingAction's
 * own header for the full argument.
 *
 * NON-NEGOTIABLE #2: see fetch-records.ts's own header for the full
 * reasoning on why every record this function ever reads comes from
 * getLeadsForCustomer/getTasksForCustomer/getContactsPage (the real,
 * RLS-respecting pages' own data source), never
 * get_automation_records(). The model is never given a query to run —
 * every fetch below happens in this file, before the model's guess is
 * ever compared against anything real.
 */
export type AssistantTurnResult = {
  reply: string;
  formTrigger?: AssistantFormTrigger;
  /** Set whenever a create/edit turn resolved to something safely
   *  confirmable without guessing a real human decision — see each
   *  switch case below for exactly when this is (vs. falling back to
   *  `formTrigger`, opening the real dialog directly, unchanged from
   *  before this feature). The chat panel renders this as an inline
   *  card with real Confirm/Cancel/"Edit instead" buttons — see
   *  AssistantPendingAction's own header for the full safety argument. */
  pendingAction?: AssistantPendingAction;
  /** Set whenever a "summarize"/lookup request resolved to one real
   *  record, or a short list of candidates — the chat panel renders
   *  each as a compact, clickable option instead of `reply` containing
   *  a flat summary. Clicking one calls getRecordDetailAction below,
   *  which builds the fuller, deterministic, labeled-field summary.
   *  Omitted (not even an empty array) on every other kind of turn. */
  recordCards?: AssistantRecordCard[];
  /** The UPDATED value for the client to store as its own
   *  LastReferencedRecord state (see that type's own doc comment).
   *  THREE-STATE, and the distinction matters: omitted entirely means
   *  "leave the client's existing value alone" (nothing this turn
   *  confidently resolved to one specific record, but whatever was
   *  established earlier is still valid); an explicit `null` means
   *  "clear it" (a bulk/list result just made the subject ambiguous);
   *  a real object means "this is the new one". Every branch below
   *  sets this deliberately — never left to fall out by accident. */
  lastReferencedRecord?: LastReferencedRecord;
};

/** Same detection and same reasoning as Leads' own describeAllTiersFailed
 *  (features/leads/actions.ts) and Meeting Notes' original — kept as its
 *  own small copy rather than a shared import because each feature's
 *  copy is free to phrase its own fallback advice ("try again" vs "add
 *  this manually") differently, and three tiny, independent copies of a
 *  string-matching heuristic is a smaller risk than a shared import
 *  whose phrasing one feature can't change without affecting the
 *  others.
 *
 * BUG FIX (real transcript, 2026-09-28): a genuine parse/shape failure
 * across every tier used to fall back to a flat "I couldn't make sense
 * of that... rephrase it" — a dead end that makes the user start the
 * whole request over, observed in practice on a message like "i want to
 * edit this" (a bare pronoun reference with no name attached is a
 * harder generation task for a small free model, and was the actual
 * trigger for one real all-tiers failure). Rather than guess the exact
 * intent from a response we couldn't parse at all, this checks the
 * ORIGINAL, UNPARSED user message for the one narrow, common shape
 * worth a targeted question: an edit-like verb plus a bare pronoun and
 * nothing else identifying. That case gets an actionable clarifying
 * question instead of "rephrase". Everything else still gets the
 * honest, generic fallback — this is not a guess at intent, only a
 * better question for one specific, recognizable failure shape.
 */
function describeAllTiersFailed(attempts: string[], userMessage: string): string {
  const everyTierThrottled =
    attempts.length > 0 && attempts.every((line) => line.includes("rate-limited") || line.includes("timed out"));

  if (everyTierThrottled) {
    return "Every AI model is busy or rate-limited right now. Please wait a minute and try again.";
  }

  const hasBarePronoun = /\b(this|that|it)\b/i.test(userMessage);
  const hasEditVerb = /\b(edit|update|change|modify|fix)\b/i.test(userMessage);
  const namesSomethingSpecific = /[A-Z][a-z]+\s+[A-Z][a-z]+/.test(userMessage);
  if (hasBarePronoun && hasEditVerb && !namesSomethingSpecific) {
    return "Which lead, task, or contact would you like to edit? Naming it (or telling me it's the one we were just discussing) will help.";
  }

  return "I couldn't make sense of that, even after retrying with a different model. Could you rephrase it, or tell me specifically which lead, task, or contact you mean?";
}

function leadSearchText(lead: Pick<SummarizableLead, "contact_name" | "company">): string {
  return `${lead.contact_name} ${lead.company ?? ""}`;
}

function leadLabel(lead: Pick<SummarizableLead, "contact_name" | "company">): string {
  return formatLeadLabel({ contact_name: lead.contact_name, company: lead.company });
}

function taskSearchText(task: Pick<SummarizableTask, "subject" | "leadLabel">): string {
  return `${task.subject} ${task.leadLabel}`;
}

function taskLabel(task: Pick<SummarizableTask, "subject" | "due_date">): string {
  return task.due_date ? `"${task.subject}" (due ${task.due_date})` : `"${task.subject}"`;
}

function contactSearchText(contact: Pick<SummarizableContact, "name" | "company" | "leadLabel">): string {
  return `${contact.name} ${contact.company ?? ""} ${contact.leadLabel}`;
}

function contactLabel(contact: Pick<SummarizableContact, "name" | "company">): string {
  return contact.company ? `${contact.name} (${contact.company})` : contact.name;
}

/** Same formatting rule as format-summary.ts's own formatMoney (this
 *  app's real currencyFormatter, never a bare number or a "$") — kept as
 *  its own tiny copy here rather than importing that module's unexported
 *  helper, since a one-line reimplementation is simpler than exporting
 *  it just for this. */
function moneyLabel(value: number | string | null): string {
  if (value === null) return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(numeric) ? currencyFormatter.format(numeric) : "—";
}

/**
 * Turns typed values into the plain string entries the real
 * createLeadAction/updateLeadAction/createTaskAction/updateTaskAction/
 * createContactAction/updateContactAction Server Actions expect from
 * FormData — omitting a key entirely for null/undefined, exactly what
 * an HTML form does with a blank optional field (every optionalText()/
 * optionalDealValue()/etc. in those actions' own schemas already treats
 * a MISSING key as "nothing was provided", the same as a real form
 * submission where that input was left blank).
 */
function toFormPayload(fields: Record<string, string | number | null | undefined>): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    payload[key] = String(value);
  }
  return payload;
}

/** A single, reusable "resolve or ask" step — every intent that needs
 *  an existing record (edit_*, create_task/create_contact's lead,
 *  summarize's optional single-record focus) goes through this exact
 *  same function, so "matches many -> list the real candidates and
 *  ask" and "matches none -> ask for more detail" can never be
 *  implemented two different, possibly-inconsistent ways. */
function resolveOrAsk<T>(
  reference: string | null,
  candidates: readonly T[],
  getSearchableText: (item: T) => string,
  getLabel: (item: T) => string,
  nounSingular: string,
): { match: T } | { reply: string } {
  const resolution: ReferenceResolution<T> = resolveReference(reference, candidates, getSearchableText);
  if (resolution.status === "one") return { match: resolution.match };
  if (resolution.status === "many") {
    return { reply: buildDisambiguationQuestion(resolution.matches, getLabel, nounSingular) };
  }
  return { reply: buildNoMatchQuestion(nounSingular) };
}

/**
 * The SAME "resolve or ask" step, extended with real conversation
 * state (BUG FIX, real transcript 2026-09-28): when the model signals
 * `refersToLast` (the user said only "this"/"that"/"it" with nothing
 * else identifying — see classify-intent.ts rule 5), this resolves
 * DIRECTLY against `lastReferenced` — deterministic code, never the
 * model's own guess — rather than fuzzy-matching an empty/null
 * reference against the whole candidate set (which would always
 * legitimately fail, since there is nothing to match text against).
 *
 * Falls through to asking, exactly like any other unresolved
 * reference, in both sub-cases the spec calls out: nothing was
 * recently, unambiguously referenced (lastReferenced is null), or it
 * was a different KIND of record than this intent needs (a Task was
 * last discussed but the user says "edit this" in a lead-editing
 * context) — a type mismatch is real ambiguity, not something to
 * paper over by guessing.
 */
function resolveRecordReference<T extends { id: string }>(
  refersToLast: boolean,
  reference: string | null,
  lastReferenced: LastReferencedRecord,
  expectedType: NonNullable<LastReferencedRecord>["type"],
  candidates: readonly T[],
  getSearchableText: (item: T) => string,
  getLabel: (item: T) => string,
  nounSingular: string,
): { match: T } | { reply: string } {
  if (refersToLast) {
    if (lastReferenced && lastReferenced.type === expectedType) {
      const match = candidates.find((item) => item.id === lastReferenced.id);
      if (match) return { match };
    }
    // Either nothing was confidently referenced recently, or what was
    // referenced is a different kind of record than this intent needs —
    // both are genuine ambiguity, so ask rather than assume, the same
    // rule every other unresolved reference already follows.
    return {
      reply: lastReferenced
        ? `I'm not sure which ${nounSingular} you mean by that — could you tell me its name?`
        : `Which ${nounSingular} would you like to work with? Nothing specific has come up yet in this conversation.`,
    };
  }
  return resolveOrAsk(reference, candidates, getSearchableText, getLabel, nounSingular);
}

/**
 * The "summarize"/lookup counterpart to resolveRecordReference above —
 * same resolution rules (back-reference against real conversation
 * state, or fuzzy-match the model's free-text guess), but returns EVERY
 * real match (one, or up to resolveReference's own MAX_LISTED_CANDIDATES)
 * instead of collapsing "many" into a text disambiguation question.
 * This is what lets the feature's own clickable-card requirement cover
 * "a specific lead, or a short list of candidates" uniformly — the
 * caller turns each match into one AssistantRecordCard via cardsResult
 * below, never a flat paragraph.
 */
function resolveForSummaryCards<T extends { id: string }>(
  refersToLast: boolean,
  reference: string | null,
  lastReferenced: LastReferencedRecord,
  expectedType: NonNullable<LastReferencedRecord>["type"],
  candidates: readonly T[],
  getSearchableText: (item: T) => string,
  nounSingular: string,
): { matches: T[] } | { reply: string } {
  if (refersToLast) {
    if (lastReferenced && lastReferenced.type === expectedType) {
      const match = candidates.find((item) => item.id === lastReferenced.id);
      if (match) return { matches: [match] };
    }
    return {
      reply: lastReferenced
        ? `I'm not sure which ${nounSingular} you mean by that — could you tell me its name?`
        : `Which ${nounSingular} would you like a summary of? Nothing specific has come up yet in this conversation.`,
    };
  }
  const resolution = resolveReference(reference, candidates, getSearchableText);
  if (resolution.status === "none") return { reply: buildNoMatchQuestion(nounSingular) };
  return { matches: resolution.status === "one" ? [resolution.match] : resolution.matches };
}

/** Turns a set of resolved matches into the actual AssistantTurnResult:
 *  one clickable card per match, a reply that just says how many were
 *  found (never the summary itself — that's deterministically built
 *  only once the user clicks a specific card, see getRecordDetailAction
 *  below), and lastReferencedRecord set only when there's exactly one
 *  match (more than one is still genuinely ambiguous until a click
 *  disambiguates it). */
function cardsResult<T extends { id: string }>(
  type: NonNullable<LastReferencedRecord>["type"],
  matches: T[],
  getLabel: (item: T) => string,
  nounSingular: string,
): AssistantTurnResult {
  const cards: AssistantRecordCard[] = matches.map((item) => ({ type, id: item.id, label: getLabel(item) }));
  const reply =
    matches.length === 1
      ? `I found 1 ${nounSingular} matching that — click it to see the full summary.`
      : `I found ${matches.length} ${nounSingular}s matching that — click one to see its full summary.`;
  return {
    reply,
    recordCards: cards,
    lastReferencedRecord: matches.length === 1 ? { type, id: matches[0].id, label: getLabel(matches[0]) } : null,
  };
}

export async function sendAssistantMessageAction(
  history: AssistantMessage[],
  message: string,
  lastReferencedRecord: LastReferencedRecord = null,
): Promise<AssistantTurnResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const parsed = sendAssistantMessageInputSchema.safeParse({ message, history });
  if (!parsed.success) {
    return { reply: "Something went wrong sending that message. Please try again." };
  }

  // A bare greeting or general help request never reaches the model at
  // all — see detect-greeting.ts's own header for why this has to be
  // deterministic rather than relying on classification to get it
  // right every time, and for the real regression this fixes. Checked
  // against ONLY the new message (never combined with history), and
  // never touches lastReferencedRecord/formTrigger — a "hi" in the
  // middle of an otherwise real conversation is still just a "hi".
  if (detectGreetingOrHelp(parsed.data.message)) {
    return { reply: GREETING_REPLY };
  }

  const classification = await classifyIntent(parsed.data.history, parsed.data.message);
  if (!classification.ok) {
    return {
      reply:
        classification.reason === "not_configured"
          ? "The assistant isn't configured on this deployment yet. You can still use the New Lead / New Task / New Contact buttons directly."
          : describeAllTiersFailed(classification.attempts, parsed.data.message),
    };
  }

  const response = classification.value;

  // "unclear" is always a clarification, defensively, regardless of what
  // `status` the model reported for it (rule #10 in the system prompt
  // already asks for this pairing; this is the backstop, not the
  // primary enforcement). Neither branch touches lastReferencedRecord —
  // needing to ask something else doesn't invalidate whatever was
  // already confidently established earlier in the conversation.
  if (response.status === "NEEDS_CLARIFICATION" || response.intent === "unclear") {
    const questions =
      response.status === "NEEDS_CLARIFICATION"
        ? response.questions
        : ["What would you like to do — create, edit, or get a summary of a Lead, Task, or Contact?"];
    return { reply: questions.join(" ") };
  }

  const { intent, record_reference, refers_to_last_discussed, fields } = response;
  const customerId = membership.customer.id;

  switch (intent) {
    case "create_lead": {
      const source = fields.source && LEAD_SOURCES.includes(fields.source) ? fields.source : null;
      const editFallback: AssistantFormTrigger = {
        type: "create_lead",
        prefill: {
          contact_name: fields.contact_name ?? undefined,
          company: fields.company,
          email: fields.email,
          phone: fields.phone,
          deal_value: fields.deal_value,
          source,
          next_step: fields.next_step,
        },
      };

      // A brand-new lead must start on SOME real, Active stage — unlike
      // Task's priority/type/assignee below, the real form has no
      // pre-selected default of its own here at all (LeadFormFields'
      // own <option value="" disabled>Select a stage</option> — a human
      // must always explicitly pick one). This picks the first Active
      // stage by display_order (the pipeline's own leftmost column, the
      // closest thing to a natural starting point) and shows it plainly
      // as a real field on the card below — never hidden, and still
      // changeable via "Edit instead" like anything else here.
      const stages = await getLeadStagesForCustomer(supabase, customerId);
      const firstActiveStage = stages.find((stage) => stage.status === "Active") ?? null;
      if (!firstActiveStage) {
        // No Active stage exists for this customer at all — falls back
        // to the real dialog, which will show the same "Select a
        // stage" requirement a human hits today; nothing to confirm.
        return {
          reply: "Here's a New Lead form, pre-filled from what you told me — review it and click Save when you're ready.",
          formTrigger: editFallback,
        };
      }

      const payload = toFormPayload({
        contact_name: fields.contact_name,
        phone: fields.phone,
        email: fields.email,
        company: fields.company,
        deal_value: fields.deal_value,
        stage_id: firstActiveStage.id,
        source,
        next_step: fields.next_step,
      });

      return {
        reply: "Here's what I'll create — take a look and confirm.",
        pendingAction: {
          kind: "create_lead",
          title: "New Lead",
          fields: [
            { label: "Name", value: fields.contact_name ?? "—" },
            { label: "Phone", value: fields.phone ?? "—" },
            { label: "Company", value: fields.company ?? "—" },
            { label: "Email", value: fields.email ?? "—" },
            { label: "Deal Value", value: moneyLabel(fields.deal_value) },
            { label: "Stage", value: firstActiveStage.stage },
            { label: "Source", value: source ?? "—" },
            { label: "Next Step", value: fields.next_step ?? "—" },
          ],
          payload,
          editFallback,
        },
        // A brand-new lead has no id until it's actually saved (which
        // this action never does — see the file header) — nothing
        // concrete to reference yet, and whatever was last discussed
        // before this is still perfectly valid to fall back to, so it
        // is deliberately left unchanged rather than cleared.
      };
    }

    case "create_task": {
      const leads = await fetchVisibleLeads(supabase, customerId);
      const resolved = resolveRecordReference(
        refers_to_last_discussed,
        record_reference,
        lastReferencedRecord,
        "lead",
        leads,
        leadSearchText,
        leadLabel,
        "lead",
      );
      if ("reply" in resolved) {
        return { reply: `${resolved.reply} (Every task has to be linked to an existing lead.)` };
      }
      const lead = resolved.match;

      let assigneeHint: TaskAssigneeHint | undefined;
      if (fields.assignee_name) {
        const directory = await getVisibleTeamDirectory(supabase);
        const nameResolution = resolveReference(fields.assignee_name, directory, (member) => `${member.name ?? ""} ${member.email}`);
        assigneeHint = {
          sourceName: fields.assignee_name,
          matchedCustomerUserId: nameResolution.status === "one" ? nameResolution.match.customer_user_id : null,
        };
      }

      const priority = fields.priority && (TASK_PRIORITIES as readonly string[]).includes(fields.priority) ? (fields.priority as TaskPriority) : null;
      const type = fields.type && (TASK_TYPES as readonly string[]).includes(fields.type) ? (fields.type as TaskType) : null;
      const dueDate = fields.due_date && isRealIsoDate(fields.due_date) ? fields.due_date : null;

      const editFallback: AssistantFormTrigger = {
        type: "create_task",
        prefill: {
          subject: fields.subject ?? undefined,
          description: fields.description ?? undefined,
          priority: priority ?? undefined,
          due_date: dueDate ?? undefined,
          type: type ?? undefined,
        },
        defaultLead: { id: lead.id, label: leadLabel(lead) },
        assigneeHint,
      };
      // The resolved LEAD is what's concretely referenceable here —
      // the new task itself has no id until saved.
      const leadReference: LastReferencedRecord = { type: "lead", id: lead.id, label: leadLabel(lead) };

      // Two things this feature will never silently decide FOR the
      // user: a due date (no safe default exists — the real form's own
      // required date picker is deliberately what catches this, per
      // classify-intent.ts's own header) and WHO a task is assigned to
      // whenever a name was actually mentioned (assigneeHint only ever
      // ANNOTATES a suggestion — auto-confirming to "yourself" while the
      // message named someone else would be actively misleading). Either
      // gap falls back to opening the real dialog directly, exactly the
      // same behavior as before this feature existed.
      if (!dueDate || fields.assignee_name) {
        return {
          reply: `Here's a New Task form, linked to ${leadLabel(lead)} and pre-filled from what you told me — review it and click Save when you're ready.`,
          formTrigger: editFallback,
          lastReferencedRecord: leadReference,
        };
      }

      const payload = toFormPayload({
        subject: fields.subject,
        description: fields.description,
        priority: priority ?? "Medium",
        due_date: dueDate,
        assigned_to: membership.membership.id,
        lead_id: lead.id,
        type: type ?? "Other",
      });

      return {
        reply: "Here's what I'll create — take a look and confirm.",
        pendingAction: {
          kind: "create_task",
          title: "New Task",
          fields: [
            { label: "Subject", value: fields.subject ?? "—" },
            { label: "Lead", value: leadLabel(lead) },
            { label: "Type", value: type ?? "Other" },
            { label: "Priority", value: priority ?? "Medium" },
            { label: "Due Date", value: dueDate },
            { label: "Assigned To", value: "You" },
            { label: "Description", value: fields.description ?? "—" },
          ],
          payload,
          editFallback,
        },
        lastReferencedRecord: leadReference,
      };
    }

    case "create_contact": {
      const leads = await fetchVisibleLeads(supabase, customerId);
      const resolved = resolveRecordReference(
        refers_to_last_discussed,
        record_reference,
        lastReferencedRecord,
        "lead",
        leads,
        leadSearchText,
        leadLabel,
        "lead",
      );
      if ("reply" in resolved) {
        return { reply: `${resolved.reply} (Every contact has to be linked to an existing lead.)` };
      }
      const lead = resolved.match;

      const editFallback: AssistantFormTrigger = {
        type: "create_contact",
        prefill: {
          name: fields.contact_name ?? undefined,
          company: fields.company,
          title: fields.title,
          email: fields.email,
          phone: fields.phone,
        },
        defaultLead: { id: lead.id, label: leadLabel(lead) },
      };

      const payload = toFormPayload({
        name: fields.contact_name,
        company: fields.company,
        title: fields.title,
        email: fields.email,
        phone: fields.phone,
        lead_id: lead.id,
        owner_id: membership.membership.id,
      });

      return {
        reply: "Here's what I'll create — take a look and confirm.",
        pendingAction: {
          kind: "create_contact",
          title: "New Contact",
          fields: [
            { label: "Name", value: fields.contact_name ?? "—" },
            { label: "Lead", value: leadLabel(lead) },
            { label: "Company", value: fields.company ?? "—" },
            { label: "Title", value: fields.title ?? "—" },
            { label: "Email", value: fields.email ?? "—" },
            { label: "Phone", value: fields.phone ?? "—" },
            { label: "Owner", value: "You" },
          ],
          payload,
          editFallback,
        },
        lastReferencedRecord: { type: "lead", id: lead.id, label: leadLabel(lead) },
      };
    }

    case "edit_lead": {
      const leads = await fetchVisibleLeads(supabase, customerId);
      const resolved = resolveRecordReference(
        refers_to_last_discussed,
        record_reference,
        lastReferencedRecord,
        "lead",
        leads,
        leadSearchText,
        leadLabel,
        "lead",
      );
      if ("reply" in resolved) return { reply: resolved.reply };

      const fullLead = await fetchLeadForEdit(supabase, customerId, resolved.match.id);
      if (!fullLead) {
        return { reply: "I found that lead a moment ago, but couldn't load its full details just now. Please try again." };
      }
      const leadReference: LastReferencedRecord = { type: "lead", id: fullLead.id, label: leadLabel(fullLead) };

      const source = fields.source && LEAD_SOURCES.includes(fields.source) ? fields.source : null;

      // Resolve a requested stage NAME against this customer's real,
      // CURRENT stages — the exact same fuzzy-match-or-ask mechanism
      // record_reference itself already goes through (resolveReference),
      // never trusted as a stage_id straight from the model (which never
      // sees one — see AssistantFields.stage's own doc comment). Only
      // Active stages are offered, matching LeadFormFields' own
      // selectable-stages rule, except the lead's own CURRENT stage,
      // which must stay matchable even if it's since been deactivated.
      let resolvedStageId: string | null = null;
      let resolvedStageName: string | null = null;
      if (fields.stage) {
        const stages = await getLeadStagesForCustomer(supabase, customerId);
        const selectableStages = stages.filter((stage) => stage.status === "Active" || stage.id === fullLead.stage_id);
        const stageResolution = resolveReference(fields.stage, selectableStages, (stage) => stage.stage);
        if (stageResolution.status === "none") {
          return { reply: buildNoMatchQuestion("stage"), lastReferencedRecord: leadReference };
        }
        if (stageResolution.status === "many") {
          return {
            reply: buildDisambiguationQuestion(stageResolution.matches, (stage) => stage.stage, "stage"),
            lastReferencedRecord: leadReference,
          };
        }
        resolvedStageId = stageResolution.match.id;
        resolvedStageName = stageResolution.match.stage;
      }

      const nextContactName = fields.contact_name ?? fullLead.contact_name;
      const nextCompany = fields.company ?? fullLead.company;
      const nextEmail = fields.email ?? fullLead.email;
      const nextPhone = fields.phone ?? fullLead.phone;
      const nextDealValue = fields.deal_value ?? fullLead.deal_value;
      const nextSource = source ?? fullLead.source;
      const nextNextStep = fields.next_step ?? fullLead.next_step;
      const nextStageId = resolvedStageId ?? fullLead.stage_id;

      const editFallback: AssistantFormTrigger = {
        type: "edit_lead",
        lead: {
          ...fullLead,
          contact_name: nextContactName,
          company: nextCompany,
          email: nextEmail,
          phone: nextPhone,
          deal_value: nextDealValue,
          source: nextSource,
          next_step: nextNextStep,
          stage_id: nextStageId,
        },
      };

      // ONLY the fields actually different make it onto the
      // confirmation card — a before -> after diff, never a full-record
      // dump (per this feature's own "not a dump of every field" rule).
      const diffFields: AssistantPendingActionField[] = [];
      if (fields.contact_name !== null && fields.contact_name !== fullLead.contact_name) {
        diffFields.push({ label: "Name", value: nextContactName, previousValue: fullLead.contact_name });
      }
      if (fields.company !== null && fields.company !== fullLead.company) {
        diffFields.push({ label: "Company", value: nextCompany ?? "—", previousValue: fullLead.company ?? "—" });
      }
      if (fields.email !== null && fields.email !== fullLead.email) {
        diffFields.push({ label: "Email", value: nextEmail ?? "—", previousValue: fullLead.email ?? "—" });
      }
      if (fields.phone !== null && fields.phone !== fullLead.phone) {
        diffFields.push({ label: "Phone", value: nextPhone ?? "—", previousValue: fullLead.phone ?? "—" });
      }
      if (fields.deal_value !== null && fields.deal_value !== Number(fullLead.deal_value ?? NaN)) {
        diffFields.push({ label: "Deal Value", value: moneyLabel(nextDealValue), previousValue: moneyLabel(fullLead.deal_value) });
      }
      if (source !== null && source !== fullLead.source) {
        diffFields.push({ label: "Source", value: nextSource ?? "—", previousValue: fullLead.source ?? "—" });
      }
      if (fields.next_step !== null && fields.next_step !== fullLead.next_step) {
        diffFields.push({ label: "Next Step", value: nextNextStep ?? "—", previousValue: fullLead.next_step ?? "—" });
      }
      if (resolvedStageId !== null && resolvedStageId !== fullLead.stage_id) {
        const previousStageName = await fetchStageName(supabase, customerId, fullLead.stage_id);
        diffFields.push({ label: "Stage", value: resolvedStageName ?? "—", previousValue: previousStageName ?? "—" });
      }

      if (diffFields.length === 0) {
        // Nothing actually changed — open the real dialog for review
        // instead of showing a confirm card with nothing to confirm.
        return {
          reply: `Here's ${leadLabel(fullLead)}'s edit form — review it and click Save to confirm.`,
          formTrigger: editFallback,
          lastReferencedRecord: leadReference,
        };
      }

      const payload = toFormPayload({
        id: fullLead.id,
        contact_name: nextContactName,
        phone: nextPhone,
        email: nextEmail,
        company: nextCompany,
        whatsapp_phone: fullLead.whatsapp_phone,
        address: fullLead.address,
        deal_value: nextDealValue,
        expected_close_date: fullLead.expected_close_date,
        stage_id: nextStageId,
        owner_id: fullLead.owner_id,
        source: nextSource,
        next_step: nextNextStep,
      });

      return {
        reply: "Here's what I'll update — take a look and confirm.",
        pendingAction: {
          kind: "edit_lead",
          title: `Update ${leadLabel(fullLead)}`,
          fields: diffFields,
          payload,
          editFallback,
        },
        lastReferencedRecord: leadReference,
      };
    }

    case "edit_task": {
      const tasks = await fetchVisibleTasks(supabase, customerId);
      const resolved = resolveRecordReference(
        refers_to_last_discussed,
        record_reference,
        lastReferencedRecord,
        "task",
        tasks,
        taskSearchText,
        taskLabel,
        "task",
      );
      if ("reply" in resolved) return { reply: resolved.reply };

      const fullTask = await fetchTaskForEdit(supabase, customerId, resolved.match.id);
      if (!fullTask) {
        return { reply: "I found that task a moment ago, but couldn't load its full details just now. Please try again." };
      }
      const taskReference: LastReferencedRecord = { type: "task", id: fullTask.task.id, label: taskLabel(fullTask.task) };

      const priority = fields.priority && (TASK_PRIORITIES as readonly string[]).includes(fields.priority) ? (fields.priority as TaskPriority) : null;
      const type = fields.type && (TASK_TYPES as readonly string[]).includes(fields.type) ? (fields.type as TaskType) : null;
      const dueDate = fields.due_date && isRealIsoDate(fields.due_date) ? fields.due_date : null;

      const nextSubject = fields.subject ?? fullTask.task.subject;
      const nextDescription = fields.description ?? fullTask.task.description;
      const nextPriority = (priority ?? fullTask.task.priority) as TaskPriority;
      const nextDueDate = dueDate ?? fullTask.task.due_date;
      const nextType = (type ?? fullTask.task.type) as TaskType;

      const editFallback: AssistantFormTrigger = {
        type: "edit_task",
        task: {
          ...fullTask.task,
          subject: nextSubject,
          description: nextDescription,
          priority: nextPriority,
          due_date: nextDueDate,
          type: nextType,
        },
        lockedLeadLabel: fullTask.lockedLeadLabel,
      };

      const diffFields: AssistantPendingActionField[] = [];
      if (fields.subject !== null && fields.subject !== fullTask.task.subject) {
        diffFields.push({ label: "Subject", value: nextSubject, previousValue: fullTask.task.subject });
      }
      if (fields.description !== null && fields.description !== fullTask.task.description) {
        diffFields.push({ label: "Description", value: nextDescription ?? "—", previousValue: fullTask.task.description ?? "—" });
      }
      if (priority !== null && priority !== fullTask.task.priority) {
        diffFields.push({ label: "Priority", value: nextPriority, previousValue: fullTask.task.priority });
      }
      if (dueDate !== null && dueDate !== fullTask.task.due_date) {
        diffFields.push({ label: "Due Date", value: nextDueDate, previousValue: fullTask.task.due_date });
      }
      if (type !== null && type !== fullTask.task.type) {
        diffFields.push({ label: "Type", value: nextType, previousValue: fullTask.task.type });
      }

      if (diffFields.length === 0) {
        return {
          reply: `Here's ${taskLabel(fullTask.task)}'s edit form — review it and click Save to confirm.`,
          formTrigger: editFallback,
          lastReferencedRecord: taskReference,
        };
      }

      const payload = toFormPayload({
        id: fullTask.task.id,
        subject: nextSubject,
        description: nextDescription,
        priority: nextPriority,
        due_date: nextDueDate,
        assigned_to: fullTask.task.assigned_to,
        type: nextType,
        status: fullTask.task.status,
      });

      return {
        reply: "Here's what I'll update — take a look and confirm.",
        pendingAction: {
          kind: "edit_task",
          title: `Update ${taskLabel(fullTask.task)}`,
          fields: diffFields,
          payload,
          editFallback,
        },
        lastReferencedRecord: taskReference,
      };
    }

    case "edit_contact": {
      const contacts = await fetchVisibleContacts(supabase, customerId);
      const resolved = resolveRecordReference(
        refers_to_last_discussed,
        record_reference,
        lastReferencedRecord,
        "contact",
        contacts,
        contactSearchText,
        contactLabel,
        "contact",
      );
      if ("reply" in resolved) return { reply: resolved.reply };

      const fullContact = await fetchContactForEdit(supabase, customerId, resolved.match.id);
      if (!fullContact) {
        return { reply: "I found that contact a moment ago, but couldn't load its full details just now. Please try again." };
      }
      const contactReference: LastReferencedRecord = {
        type: "contact",
        id: fullContact.contact.id,
        label: contactLabel(fullContact.contact),
      };

      const nextName = fields.contact_name ?? fullContact.contact.name;
      const nextCompany = fields.company ?? fullContact.contact.company;
      const nextTitle = fields.title ?? fullContact.contact.title;
      const nextEmail = fields.email ?? fullContact.contact.email;
      const nextPhone = fields.phone ?? fullContact.contact.phone;

      const editFallback: AssistantFormTrigger = {
        type: "edit_contact",
        contact: {
          ...fullContact.contact,
          name: nextName,
          company: nextCompany,
          title: nextTitle,
          email: nextEmail,
          phone: nextPhone,
        },
        lockedLeadLabel: fullContact.lockedLeadLabel,
      };

      const diffFields: AssistantPendingActionField[] = [];
      if (fields.contact_name !== null && fields.contact_name !== fullContact.contact.name) {
        diffFields.push({ label: "Name", value: nextName, previousValue: fullContact.contact.name });
      }
      if (fields.company !== null && fields.company !== fullContact.contact.company) {
        diffFields.push({ label: "Company", value: nextCompany ?? "—", previousValue: fullContact.contact.company ?? "—" });
      }
      if (fields.title !== null && fields.title !== fullContact.contact.title) {
        diffFields.push({ label: "Title", value: nextTitle ?? "—", previousValue: fullContact.contact.title ?? "—" });
      }
      if (fields.email !== null && fields.email !== fullContact.contact.email) {
        diffFields.push({ label: "Email", value: nextEmail ?? "—", previousValue: fullContact.contact.email ?? "—" });
      }
      if (fields.phone !== null && fields.phone !== fullContact.contact.phone) {
        diffFields.push({ label: "Phone", value: nextPhone ?? "—", previousValue: fullContact.contact.phone ?? "—" });
      }

      if (diffFields.length === 0) {
        return {
          reply: `Here's ${contactLabel(fullContact.contact)}'s edit form — review it and click Save to confirm.`,
          formTrigger: editFallback,
          lastReferencedRecord: contactReference,
        };
      }

      const payload = toFormPayload({
        id: fullContact.contact.id,
        name: nextName,
        company: nextCompany,
        title: nextTitle,
        email: nextEmail,
        phone: nextPhone,
        tags: fullContact.contact.tags.join(", "),
        owner_id: fullContact.contact.owner_id,
      });

      return {
        reply: "Here's what I'll update — take a look and confirm.",
        pendingAction: {
          kind: "edit_contact",
          title: `Update ${contactLabel(fullContact.contact)}`,
          fields: diffFields,
          payload,
          editFallback,
        },
        lastReferencedRecord: contactReference,
      };
    }

    case "summarize": {
      if (!fields.object) {
        return { reply: "Would you like a summary of your Leads, Tasks, or Contacts?" };
      }

      if (fields.object === "lead") {
        const leads = await fetchVisibleLeads(supabase, customerId);
        if (record_reference || refers_to_last_discussed) {
          const resolved = resolveForSummaryCards(refers_to_last_discussed, record_reference, lastReferencedRecord, "lead", leads, leadSearchText, "lead");
          if ("reply" in resolved) return { reply: resolved.reply };
          return cardsResult("lead", resolved.matches, leadLabel, "lead");
        }

        // Bulk overview (no specific lead named) — the one summarize
        // surface that's still an LLM-authored aggregate paragraph (see
        // summarize-records.ts's own header for why). Still fixes both
        // bugs here too: each lead's real stage name and its real,
        // already-₹-formatted deal value are resolved BEFORE the model
        // ever sees them, so it only ever echoes correct text, never
        // invents a currency symbol or a stage.
        const stages = await getLeadStagesForCustomer(supabase, customerId);
        const stageNameById = new Map(stages.map((stage) => [stage.id, stage.stage]));
        const promptableLeads: PromptableLead[] = leads.map((lead) => ({
          contact_name: lead.contact_name,
          company: lead.company,
          email: lead.email,
          phone: lead.phone,
          deal_value: lead.deal_value === null ? null : currencyFormatter.format(Number(lead.deal_value)),
          stage: stageNameById.get(lead.stage_id) ?? null,
          source: lead.source,
          next_step: lead.next_step,
          status: lead.status,
        }));
        const summary = await summarizeLeads(promptableLeads, parsed.data.message);
        // A bulk/list summary just made the subject ambiguous again —
        // a later bare "this" cannot mean any one of several leads, so
        // this deliberately CLEARS the slot rather than leaving a
        // stale single record from before it referable.
        return { reply: summary.ok ? summary.summary : describeAllTiersFailed([], parsed.data.message), lastReferencedRecord: null };
      }

      if (fields.object === "task") {
        const tasks = await fetchVisibleTasks(supabase, customerId);
        if (record_reference || refers_to_last_discussed) {
          const resolved = resolveForSummaryCards(refers_to_last_discussed, record_reference, lastReferencedRecord, "task", tasks, taskSearchText, "task");
          if ("reply" in resolved) return { reply: resolved.reply };
          return cardsResult("task", resolved.matches, taskLabel, "task");
        }
        const summary = await summarizeTasks(tasks, parsed.data.message);
        return { reply: summary.ok ? summary.summary : describeAllTiersFailed([], parsed.data.message), lastReferencedRecord: null };
      }

      // fields.object === "contact"
      const contacts = await fetchVisibleContacts(supabase, customerId);
      if (record_reference || refers_to_last_discussed) {
        const resolved = resolveForSummaryCards(
          refers_to_last_discussed,
          record_reference,
          lastReferencedRecord,
          "contact",
          contacts,
          contactSearchText,
          "contact",
        );
        if ("reply" in resolved) return { reply: resolved.reply };
        return cardsResult("contact", resolved.matches, contactLabel, "contact");
      }
      const summary = await summarizeContacts(contacts, parsed.data.message);
      return { reply: summary.ok ? summary.summary : describeAllTiersFailed([], parsed.data.message), lastReferencedRecord: null };
    }

    default:
      // Exhaustiveness guard — every real intent is handled above, and
      // "unclear" was already returned before this switch.
      return { reply: "I'm not sure what to do with that yet. Could you rephrase it?" };
  }
}

export type RecordDetailResult =
  | { ok: true; summary: string; lastReferencedRecord: LastReferencedRecord }
  | { ok: false; reply: string };

/**
 * The click side of the record-card feature: turns one clicked
 * AssistantRecordCard into its full, deterministic, labeled-field
 * summary (features/assistant/lib/format-summary.ts — no LLM involved).
 *
 * The id is CLIENT-SUPPLIED (it came back from a card this same server
 * rendered a moment ago), so it is never trusted blindly: auth and
 * membership are re-verified exactly like sendAssistantMessageAction's
 * own first steps, and the record itself is re-fetched fresh through
 * the same RLS-respecting fetchLeadForEdit/fetchTaskForEdit/
 * fetchContactForEdit this file already uses for edit_* — the same
 * tenant-and-role-scoped mechanism, never a second lookup path. A
 * stale or foreign id simply resolves to "not found", never someone
 * else's record.
 */
export async function getRecordDetailAction(type: "lead" | "task" | "contact", id: string): Promise<RecordDetailResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }
  const customerId = membership.customer.id;

  if (type === "lead") {
    const lead = await fetchLeadForEdit(supabase, customerId, id);
    if (!lead) {
      return { ok: false, reply: "I couldn't find that lead anymore — it may have been deleted or moved." };
    }
    const [stageName, related] = await Promise.all([
      fetchStageName(supabase, customerId, lead.stage_id),
      fetchRelatedRecordsForLead(supabase, customerId, lead.id),
    ]);
    return {
      ok: true,
      summary: formatLeadSummary(lead, stageName, related),
      lastReferencedRecord: { type: "lead", id: lead.id, label: leadLabel(lead) },
    };
  }

  if (type === "task") {
    const full = await fetchTaskForEdit(supabase, customerId, id);
    if (!full) {
      return { ok: false, reply: "I couldn't find that task anymore — it may have been deleted." };
    }
    return {
      ok: true,
      summary: formatTaskSummary(full.task, full.lockedLeadLabel || null),
      lastReferencedRecord: { type: "task", id: full.task.id, label: taskLabel(full.task) },
    };
  }

  // type === "contact"
  const full = await fetchContactForEdit(supabase, customerId, id);
  if (!full) {
    return { ok: false, reply: "I couldn't find that contact anymore — it may have been deleted." };
  }
  return {
    ok: true,
    summary: formatContactSummary(full.contact, full.lockedLeadLabel || null),
    lastReferencedRecord: { type: "contact", id: full.contact.id, label: contactLabel(full.contact) },
  };
}

/** Reads either LeadFormState/TaskFormState/ContactFormState's shared
 *  shape ({fieldErrors?, formError?, success?}) into one user-facing
 *  sentence — never a raw Postgres error, matching every real dialog's
 *  own MessageBanner rendering of the identical state. */
function describeActionFailure(state: { fieldErrors?: Record<string, string>; formError?: string }): string {
  if (state.formError) return state.formError;
  const firstFieldError = state.fieldErrors ? Object.values(state.fieldErrors)[0] : undefined;
  if (firstFieldError) {
    return `${firstFieldError} Click "Edit instead" to fix it in the full form.`;
  }
  return 'Something went wrong saving that. Click "Edit instead" to try it in the full form.';
}

function buildLeadEditSuccessMessage(lead: PipelineLead, stageName: string | null, changedLabels: string[]): string {
  const valueByLabel: Record<string, string> = {
    Name: lead.contact_name,
    Company: lead.company ?? "—",
    Email: lead.email ?? "—",
    Phone: lead.phone ?? "—",
    "Deal Value": moneyLabel(lead.deal_value),
    Source: lead.source ?? "—",
    "Next Step": lead.next_step ?? "—",
    Stage: stageName ?? "—",
  };
  if (changedLabels.length === 0) return "Updated — all done.";
  const parts = changedLabels.map((label) => `${label} changed to ${valueByLabel[label] ?? "—"}`);
  return `${parts.join(", ")} — all done.`;
}

function buildTaskEditSuccessMessage(task: Task, changedLabels: string[]): string {
  const valueByLabel: Record<string, string> = {
    Subject: task.subject,
    Description: task.description ?? "—",
    Priority: task.priority,
    "Due Date": task.due_date,
    Type: task.type,
  };
  if (changedLabels.length === 0) return "Updated — all done.";
  const parts = changedLabels.map((label) => `${label} changed to ${valueByLabel[label] ?? "—"}`);
  return `${parts.join(", ")} — all done.`;
}

function buildContactEditSuccessMessage(contact: ContactListItem, changedLabels: string[]): string {
  const valueByLabel: Record<string, string> = {
    Name: contact.name,
    Company: contact.company ?? "—",
    Title: contact.title ?? "—",
    Email: contact.email ?? "—",
    Phone: contact.phone ?? "—",
  };
  if (changedLabels.length === 0) return "Updated — all done.";
  const parts = changedLabels.map((label) => `${label} changed to ${valueByLabel[label] ?? "—"}`);
  return `${parts.join(", ")} — all done.`;
}

export type ConfirmAssistantActionResult = { success: true; message: string } | { success: false; message: string };

/**
 * The Confirm button's ONLY server-side counterpart, and the ONLY place
 * in this whole feature that ever writes to `leads`/`tasks`/`contacts` —
 * see AssistantPendingAction's own header for the full safety argument.
 *
 * THIS FUNCTION DOES NOTHING BUT: (1) re-verify auth/membership exactly
 * like every other action in this file, (2) rebuild a real FormData from
 * `payload` (already built entirely from resolved, validated data in
 * sendAssistantMessageAction — see each switch case above, never raw
 * unvalidated model text), and (3) call the ONE real, unmodified Server
 * Action `kind` names — createLeadAction/updateLeadAction/
 * createTaskAction/updateTaskAction/createContactAction/
 * updateContactAction, the exact same function identifiers the real
 * dialogs' own <form action={...}> already bind to. It re-implements no
 * validation, no authorization, and no database write of its own — every
 * one of those still happens exactly once, inside the real action being
 * called.
 *
 * `changedFieldLabels` is which of `pendingAction.fields`' OWN labels to
 * mention in an EDIT's success message (ignored for a create, which
 * always describes the new record instead) — plain fixed-vocabulary
 * strings this same file already generated when it built the card
 * (never raw model text), passed back through so the success message
 * can name exactly what changed. The record is re-fetched fresh AFTER
 * the save (never reusing the pre-save values the card itself showed)
 * so the message reflects what is actually now stored, not merely what
 * was proposed before confirmation.
 */
export async function confirmAssistantActionAction(
  kind: AssistantPendingActionKind,
  payload: Record<string, string>,
  changedFieldLabels: string[],
): Promise<ConfirmAssistantActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }
  const customerId = membership.customer.id;

  const formData = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    formData.set(key, value);
  }

  switch (kind) {
    case "create_lead": {
      const result = await createLeadAction(initialLeadFormState, formData);
      if (!result.success) return { success: false, message: describeActionFailure(result) };
      const label = payload.company ? `${payload.contact_name} — ${payload.company}` : payload.contact_name;
      return { success: true, message: `Lead created — ${label}. All done.` };
    }

    case "edit_lead": {
      const result = await updateLeadAction(initialLeadFormState, formData);
      if (!result.success) return { success: false, message: describeActionFailure(result) };
      const updated = await fetchLeadForEdit(supabase, customerId, payload.id);
      if (!updated) return { success: true, message: "Updated — all done." };
      const stageName = await fetchStageName(supabase, customerId, updated.stage_id);
      return { success: true, message: buildLeadEditSuccessMessage(updated, stageName, changedFieldLabels) };
    }

    case "create_task": {
      const result = await createTaskAction(initialTaskFormState, formData);
      if (!result.success) return { success: false, message: describeActionFailure(result) };
      if (result.taskId) {
        const full = await fetchTaskForEdit(supabase, customerId, result.taskId);
        if (full) {
          return { success: true, message: `Task created — "${full.task.subject}" (due ${full.task.due_date}). All done.` };
        }
      }
      return { success: true, message: `Task created — "${payload.subject}" (due ${payload.due_date}). All done.` };
    }

    case "edit_task": {
      const result = await updateTaskAction(initialTaskFormState, formData);
      if (!result.success) return { success: false, message: describeActionFailure(result) };
      const updated = await fetchTaskForEdit(supabase, customerId, payload.id);
      if (!updated) return { success: true, message: "Updated — all done." };
      return { success: true, message: buildTaskEditSuccessMessage(updated.task, changedFieldLabels) };
    }

    case "create_contact": {
      const result = await createContactAction(initialContactFormState, formData);
      if (!result.success) return { success: false, message: describeActionFailure(result) };
      const label = payload.company ? `${payload.name} (${payload.company})` : payload.name;
      return { success: true, message: `Contact added — ${label}. All done.` };
    }

    case "edit_contact": {
      const result = await updateContactAction(initialContactFormState, formData);
      if (!result.success) return { success: false, message: describeActionFailure(result) };
      const updated = await fetchContactForEdit(supabase, customerId, payload.id);
      if (!updated) return { success: true, message: "Updated — all done." };
      return { success: true, message: buildContactEditSuccessMessage(updated.contact, changedFieldLabels) };
    }

    default:
      return { success: false, message: "Something went wrong — unrecognized action." };
  }
}

// Voice input's transcription step no longer lives here at all — it now
// runs entirely client-side via the browser's own SpeechRecognition API
// (features/assistant/components/use-voice-recorder.ts). There is no
// server-side voice route left to find: no audio is ever uploaded, so
// there is nothing left for a Server Action to receive or transcribe.
