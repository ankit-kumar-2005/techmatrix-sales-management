import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTION_TASK_CREATE, getRegistryEntry } from "./definitions";
import { buildAutomationKey } from "../lib/idempotency";
import { renderTemplate, type LeadFacts } from "../lib/plan-workflow";
import { MAX_SUBJECT_LENGTH, MAX_DESCRIPTION_LENGTH } from "../config/safeguards";

/**
 * THE SERVER HALF OF THE REGISTRY — what each action actually does.
 *
 * Split from definitions.ts because that file is imported by Client
 * Components (the palette, the config panel) and this one is not: it
 * reaches the database. Both are keyed by the same exported constants,
 * so an action cannot exist in one and not the other without the
 * dispatch below failing loudly rather than quietly doing nothing.
 *
 * EVERY EXECUTOR GOES THROUGH A TOKEN-GATED SECURITY DEFINER FUNCTION.
 * None of them writes to a table directly, and none of them holds a
 * privileged client. The engine has no session — auth.uid() is null —
 * so a direct insert would be refused by RLS anyway; routing through a
 * named SQL function with a fixed signature is what keeps the privilege
 * narrow and auditable instead of blanket.
 */

export type ActionContext = {
  supabase: SupabaseClient;
  workerToken: string;
  customerId: string;
  leadId: string;
  automationId: string;
  version: number;
  eventId: string;
  nodeId: string;
  facts: LeadFacts;
  /** Server-resolved date the run is happening on, ISO yyyy-mm-dd.
   *  Passed in rather than read here so every action in one run agrees
   *  on "today" — a batch that straddles midnight must not schedule two
   *  tasks from the same event a day apart. */
  todayIso: string;
};

export type ActionOutcome = {
  /** True when the action did what it was asked, OR when it correctly
   *  declined because the work was already done. */
  ok: boolean;
  /** A short status for the run log. Never carries user data. */
  detail: string;
  /** Whether retrying this event could plausibly succeed. A
   *  misconfigured workflow is false — retrying it three times just
   *  burns the budget of an event that can never succeed. */
  retryable: boolean;
  /** True when the write was suppressed because it had already
   *  happened. Counted as success, but not counted as an action against
   *  the per-event ceiling. */
  deduplicated?: boolean;
};

type Executor = (context: ActionContext, config: Record<string, unknown>) => Promise<ActionOutcome>;

/**
 * Create a task on the lead that triggered the automation.
 *
 * Everything that could be wrong is decided by the database, not here:
 * whether the lead is really this tenant's, whether the assignee is
 * still an active member, whether the rotation should advance, and
 * whether this exact work has already been done. This function's job is
 * to shape the call and translate the answer — it deliberately does not
 * re-implement any of those checks, because a second copy could only
 * ever agree or be wrong.
 */
const createTask: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_TASK_CREATE);
  if (!entry) {
    return { ok: false, detail: "The create-task action is not registered.", retryable: false };
  }

  // Re-parsed at the moment of execution, not trusted from storage. A
  // definition written by an older build of this app, or by a version
  // whose rules have since tightened, is untrusted input like anything
  // else.
  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Task settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as {
    subject: string;
    description: string | null;
    type: string;
    priority: string;
    dueInDays: number;
    assignmentMode: "Fixed" | "RoundRobin";
    assigneeId: string | null;
    rotation: string[];
  };

  const subject = renderTemplate(settings.subject, context.facts).slice(0, MAX_SUBJECT_LENGTH);
  const description = settings.description
    ? renderTemplate(settings.description, context.facts).slice(0, MAX_DESCRIPTION_LENGTH)
    : null;

  if (!subject) {
    // Every placeholder resolved to an empty string and nothing else was
    // written. tasks_subject_not_blank would reject it; caught here so
    // the run log can say why rather than reporting a constraint name.
    return { ok: false, detail: "The task subject came out empty after filling in the placeholders.", retryable: false };
  }

  const { data, error } = await context.supabase.rpc("create_automation_task", {
    p_token: context.workerToken,
    p_customer_id: context.customerId,
    p_lead_id: context.leadId,
    p_automation_id: context.automationId,
    p_automation_key: buildAutomationKey({
      automationId: context.automationId,
      version: context.version,
      eventId: context.eventId,
      nodeId: context.nodeId,
    }),
    p_subject: subject,
    p_description: description,
    p_type: settings.type,
    p_priority: settings.priority,
    p_due_date: addDays(context.todayIso, settings.dueInDays),
    p_assignment_mode: settings.assignmentMode,
    p_fixed_assignee: settings.assignmentMode === "Fixed" ? settings.assigneeId : null,
    p_round_robin_pool: settings.assignmentMode === "RoundRobin" ? settings.rotation : [],
  });

  if (error) {
    // Code only — a task subject can carry a real company's name.
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  switch (data as string) {
    case "created":
      return { ok: true, detail: "Task created.", retryable: false };
    case "duplicate":
      return { ok: true, detail: "Task already created for this event.", retryable: false, deduplicated: true };
    case "no_eligible_assignee":
      return {
        ok: false,
        detail: "Nobody this task could be assigned to is still an active member.",
        retryable: false,
      };
    case "invalid_lead":
      return { ok: false, detail: "The lead this event refers to no longer exists.", retryable: false };
    case "invalid_automation":
      // The automation does not exist, or does not belong to this
      // tenant. Not retryable, and it should be impossible to reach from
      // here — the engine only ever acts on automations
      // get_active_automations handed it for this customer. Reaching it
      // means the engine and the database disagree about what exists,
      // which is worth a distinct, findable message rather than a
      // generic failure.
      return { ok: false, detail: "This automation could not be found for this organisation.", retryable: false };
    case "automation_not_active":
      // Switched off, or its version pointer cleared, between the engine
      // reading it and the write landing. Correct behaviour, not a
      // failure of the automation's design — so it is reported plainly
      // and not retried.
      return { ok: false, detail: "This automation was switched off before the task could be created.", retryable: false };
    case "unauthorized":
      // The worker token is wrong or missing. Retryable: it is an
      // environment problem, and it will start working the moment the
      // environment is fixed, without losing the event.
      return { ok: false, detail: "The automation worker is not authorised.", retryable: true };
    default:
      return { ok: false, detail: `Task was refused: ${String(data)}.`, retryable: false };
  }
};

/** Date arithmetic on the calendar day, matching tasks.due_date being a
 *  plain `date` — no timezone conversion to get wrong (the tasks
 *  migration's own reasoning). UTC accessors throughout so the result
 *  does not depend on the server's local zone. */
function addDays(todayIso: string, days: number): string {
  const base = new Date(`${todayIso}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * The dispatch table. An action key with no entry here cannot run — the
 * engine reports it and stops rather than guessing, which is what keeps
 * "the registry is the menu" true at execution time and not just at
 * authoring time.
 */
const EXECUTORS: Record<string, Executor> = {
  [ACTION_TASK_CREATE]: createTask,
};

export function getActionExecutor(key: string): Executor | undefined {
  return EXECUTORS[key];
}
