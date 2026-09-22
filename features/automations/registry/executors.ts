import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACTION_CONTACT_CREATE,
  ACTION_CONTACT_DEACTIVATE,
  ACTION_CONTACT_UPDATE,
  ACTION_GET_RECORDS,
  ACTION_LEAD_DEACTIVATE,
  ACTION_LEAD_UPDATE,
  ACTION_LOOP,
  ACTION_TASK_CREATE,
  ACTION_TASK_DEACTIVATE,
  ACTION_TASK_UPDATE,
  getRegistryEntry,
} from "./definitions";
import { buildAutomationKey } from "../lib/idempotency";
import {
  evaluateFieldGroup,
  renderTemplate,
  type LeadFacts,
  type RecordVariableValue,
  type TriggerObject,
} from "../lib/plan-workflow";
import { fieldRegistryForObject } from "./object-fields";
import type { ConditionGroup } from "./condition-group";
import { MAX_SUBJECT_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_NEXT_STEP_LENGTH, MAX_LOOP_ITERATIONS } from "../config/safeguards";

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
  /** THE LINEAGE OF THE EVENT BEING PROCESSED RIGHT NOW. An action whose
   *  write can itself cause a new event (currently only updateLead —
   *  createTask never touches `leads`) MUST hand these to the database
   *  so that new event inherits this chain instead of starting a fresh
   *  one at depth 0. Found and fixed by testing the real execution
   *  path: without this, an Update Lead action could re-trigger itself
   *  forever, with every generation looking like an unrelated new root
   *  to MAX_WORKFLOW_DEPTH and the ancestry check — see
   *  update_lead_via_automation and enqueue_lead_automation_event in
   *  20260922120000_automation_update_triggers.sql. */
  rootEventId: string;
  correlationId: string;
  depth: number;
  /**
   * Get Records writes into this; Loop reads from it. ONE map per
   * automation's run against ONE event (engine.ts constructs it fresh
   * for each automation in the `for (const automation of automations)`
   * loop) — never shared between two different automations reacting to
   * the same event, and never persisted anywhere. See RecordVariableValue's
   * own note on why this can only be execution-scoped, not plan-scoped
   * like the existing `{{var.*}}` scalars.
   */
  recordVariables: Map<string, RecordVariableValue>;
  /** How many more actions this automation's run may still perform
   *  before MAX_ACTIONS_PER_EVENT is reached — computed by engine.ts as
   *  MAX_ACTIONS_PER_EVENT minus everything already executed in this
   *  event's lineage (across every automation, not just this one). Only
   *  the Loop executor reads this: a single Loop "action" can perform
   *  many real sub-actions in one executor call, so it needs to know its
   *  own remaining allowance to stop partway through rather than
   *  overshoot the shared ceiling — see the Loop executor's own note. */
  remainingActionBudget: number;
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
  /** How many real actions this ONE executor call actually performed —
   *  defaults to 1 (an ordinary action) wherever omitted. Only Loop
   *  ever reports something other than 1: one Loop "action" can run its
   *  body several times, and this is what lets engine.ts charge the
   *  shared MAX_ACTIONS_PER_EVENT ceiling for the real number of writes
   *  that happened, not just for the one executor call that produced
   *  them. */
  actionsPerformed?: number;
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
    // LINEAGE — this insert can now re-fire tasks_enqueue_automation_event
    // (20260924120000), the same reason update_lead_via_automation has
    // always needed these three.
    p_root_event_id: context.rootEventId,
    p_correlation_id: context.correlationId,
    p_depth: context.depth,
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

/**
 * Update the lead that triggered the automation.
 *
 * The SAME shape as createTask: re-parse the config at execution time,
 * build a deterministic idempotency key, call the one SECURITY DEFINER
 * function, translate its answer. update_lead_via_automation owns every
 * check that matters (tenancy, eligibility, the allowlist, assignee
 * validity) — this function does not repeat any of them, only shapes
 * the call and reports the result.
 */
const updateLead: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_LEAD_UPDATE);
  if (!entry) {
    return { ok: false, detail: "The update-lead action is not registered.", retryable: false };
  }

  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Update-lead settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as {
    nextStep: string;
    dealValue: string;
    status: "" | "Active" | "Inactive";
    assignmentMode: "None" | "Fixed" | "RoundRobin";
    assigneeId: string | null;
    rotation: string[];
  };

  // "" at the config layer means "leave this field alone" (the
  // registry's own documented convention for this action) — translated
  // here into the SQL layer's equivalent, a real NULL parameter.
  const nextStep = settings.nextStep
    ? renderTemplate(settings.nextStep, context.facts).slice(0, MAX_NEXT_STEP_LENGTH)
    : null;
  const dealValue = settings.dealValue === "" ? null : Number(settings.dealValue);
  const status = settings.status === "" ? null : settings.status;
  const assignOwner = settings.assignmentMode !== "None";

  const { data, error } = await context.supabase.rpc("update_lead_via_automation", {
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
    p_next_step: nextStep,
    p_deal_value: dealValue,
    p_status: status,
    p_assign_owner: assignOwner,
    p_assignment_mode: assignOwner ? settings.assignmentMode : "Fixed",
    p_fixed_assignee: assignOwner && settings.assignmentMode === "Fixed" ? settings.assigneeId : null,
    p_round_robin_pool: assignOwner && settings.assignmentMode === "RoundRobin" ? settings.rotation : [],
    // LINEAGE — see ActionContext's own note. Without these, the write
    // below would enqueue an unrelated fresh-root event and the loop
    // safeguards could not see it.
    p_root_event_id: context.rootEventId,
    p_correlation_id: context.correlationId,
    p_depth: context.depth,
  });

  if (error) {
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  switch (data as string) {
    case "updated":
      return { ok: true, detail: "Lead updated.", retryable: false };
    case "duplicate":
      return { ok: true, detail: "Lead already updated for this event.", retryable: false, deduplicated: true };
    case "no_eligible_assignee":
      return { ok: false, detail: "Nobody this lead could be assigned to is still an active member.", retryable: false };
    case "invalid_lead":
      return { ok: false, detail: "The lead this event refers to no longer exists.", retryable: false };
    case "invalid_automation":
      return { ok: false, detail: "This automation could not be found for this organisation.", retryable: false };
    case "automation_not_active":
      return { ok: false, detail: "This automation was switched off before the lead could be updated.", retryable: false };
    case "invalid_deal_value":
      return { ok: false, detail: "The configured deal value is not valid.", retryable: false };
    case "invalid_status":
      return { ok: false, detail: "The configured status is not valid.", retryable: false };
    case "unauthorized":
      return { ok: false, detail: "The automation worker is not authorised.", retryable: true };
    default:
      return { ok: false, detail: `Lead update was refused: ${String(data)}.`, retryable: false };
  }
};

/**
 * Deactivate the lead that triggered the automation.
 *
 * The simplest executor in this registry: no config fields at all
 * (the registry entry's own `fields: []`), because there is nothing to
 * configure — it always targets context.leadId directly, the same
 * targeting model update_lead_via_automation already uses (never a
 * node-reference/automation_key lookup, since a Lead-triggered
 * workflow's own lead is already a concrete row, not something an
 * earlier step in the same run created).
 */
const deactivateLead: Executor = async (context) => {
  const { data, error } = await context.supabase.rpc("deactivate_lead_via_automation", {
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
    p_root_event_id: context.rootEventId,
    p_correlation_id: context.correlationId,
    p_depth: context.depth,
  });

  if (error) {
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  switch (data as string) {
    case "deactivated":
      return { ok: true, detail: "Lead deactivated.", retryable: false };
    case "duplicate":
      return { ok: true, detail: "Lead already deactivated for this event.", retryable: false, deduplicated: true };
    case "invalid_lead":
      return { ok: false, detail: "The lead this event refers to no longer exists.", retryable: false };
    case "invalid_automation":
      return { ok: false, detail: "This automation could not be found for this organisation.", retryable: false };
    case "automation_not_active":
      return { ok: false, detail: "This automation was switched off before the lead could be deactivated.", retryable: false };
    case "unauthorized":
      return { ok: false, detail: "The automation worker is not authorised.", retryable: true };
    default:
      return { ok: false, detail: `Lead deactivation was refused: ${String(data)}.`, retryable: false };
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

// ---------------------------------------------------------------------
// Task and Contact — a second and third write domain
// ---------------------------------------------------------------------
//
// createContact follows createTask's shape exactly. updateTask,
// updateContact, deactivateTask and deactivateContact all share one new
// idea the Lead actions never needed: TARGETING BY REFERENCE. A
// Lead-triggered workflow has no Task or Contact of its own — only ones
// an earlier Create step in the SAME workflow made. `sourceNodeId` names
// that Create node; resolveTargetKey recomputes its own deterministic
// idempotency key (the exact string buildAutomationKey would have given
// IT, using ITS OWN nodeId in place of this action's) and the SQL
// function looks the row up by that key rather than a raw id. See the
// migration's own design note 7 for the full reasoning this was checked
// against (branching, retries, parallel execution, multiple Create
// nodes) — nothing here re-derives that reasoning, it only implements
// the one new step it requires: computing the SAME key a second time,
// with a different nodeId.

/** The target row's own key — NOT this action's own idempotency key
 *  (that stays `context.nodeId`, computed the usual way at each call
 *  site below). Two different keys, two different jobs, both built by
 *  the same function. */
function resolveTargetKey(context: ActionContext, sourceNodeId: string): string {
  return buildAutomationKey({
    automationId: context.automationId,
    version: context.version,
    eventId: context.eventId,
    nodeId: sourceNodeId,
  });
}

const createContact: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_CONTACT_CREATE);
  if (!entry) {
    return { ok: false, detail: "The create-contact action is not registered.", retryable: false };
  }

  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Create-contact settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as {
    name: string;
    company: string;
    title: string;
    email: string;
    phone: string;
    assignmentMode: "Fixed" | "RoundRobin";
    assigneeId: string | null;
    rotation: string[];
  };

  const { data, error } = await context.supabase.rpc("create_automation_contact", {
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
    p_name: settings.name,
    p_company: settings.company === "" ? null : settings.company,
    p_title: settings.title === "" ? null : settings.title,
    p_email: settings.email === "" ? null : settings.email,
    p_phone: settings.phone === "" ? null : settings.phone,
    p_assignment_mode: settings.assignmentMode,
    p_fixed_assignee: settings.assignmentMode === "Fixed" ? settings.assigneeId : null,
    p_round_robin_pool: settings.assignmentMode === "RoundRobin" ? settings.rotation : [],
    // LINEAGE — this insert can now re-fire contacts_enqueue_automation_event
    // (20260924120000), the same reason update_lead_via_automation has
    // always needed these three.
    p_root_event_id: context.rootEventId,
    p_correlation_id: context.correlationId,
    p_depth: context.depth,
  });

  if (error) {
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  switch (data as string) {
    case "created":
      return { ok: true, detail: "Contact created.", retryable: false };
    case "duplicate":
      return { ok: true, detail: "Contact already created for this event.", retryable: false, deduplicated: true };
    case "no_eligible_assignee":
      return { ok: false, detail: "Nobody this contact could be assigned to is still an active member.", retryable: false };
    case "invalid_lead":
      return { ok: false, detail: "The lead this event refers to no longer exists.", retryable: false };
    case "invalid_automation":
      return { ok: false, detail: "This automation could not be found for this organisation.", retryable: false };
    case "automation_not_active":
      return { ok: false, detail: "This automation was switched off before the contact could be created.", retryable: false };
    case "invalid_name":
      return { ok: false, detail: "The configured contact name is not valid.", retryable: false };
    case "unauthorized":
      return { ok: false, detail: "The automation worker is not authorised.", retryable: true };
    default:
      return { ok: false, detail: `Contact creation was refused: ${String(data)}.`, retryable: false };
  }
};

/**
 * Shared by updateTask/updateContact/deactivateTask/deactivateContact:
 * 'target_not_found' means the referenced Create step never ran on THIS
 * event — a real, expected outcome of ordinary branching (the reference
 * is only reachable at all once validateWorkflow has confirmed SOME
 * path could reach it, not that every run's facts take that path), not
 * a workflow bug. Treated as a benign no-op success — same shape as
 * 'duplicate' — so it does not stop the rest of this automation's
 * actions from running, the way a genuine failure (break the loop) or
 * budget consumption (a real write happened) both would.
 */
function targetNotFoundOutcome(objectLabel: string, verb: string): ActionOutcome {
  return {
    ok: true,
    detail: `The referenced Create ${objectLabel} step did not run on this event — nothing to ${verb}.`,
    retryable: false,
    deduplicated: true,
  };
}

const updateTask: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_TASK_UPDATE);
  if (!entry) {
    return { ok: false, detail: "The update-task action is not registered.", retryable: false };
  }

  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Update-task settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as {
    sourceNodeId: string;
    subject: string;
    description: string;
    priority: "" | "Low" | "Medium" | "High";
    due_date: string;
    type: "" | "Call" | "Meeting" | "Email" | "Other";
    status: "" | "Pending" | "Completed";
    assignmentMode: "None" | "Fixed" | "RoundRobin";
    assigneeId: string | null;
    rotation: string[];
  };

  const assignOwner = settings.assignmentMode !== "None";
  const subject = settings.subject === "" ? null : renderTemplate(settings.subject, context.facts).slice(0, MAX_SUBJECT_LENGTH);
  const description = settings.description === "" ? null : renderTemplate(settings.description, context.facts).slice(0, MAX_DESCRIPTION_LENGTH);

  const { data, error } = await context.supabase.rpc("update_task_via_automation", {
    p_token: context.workerToken,
    p_customer_id: context.customerId,
    p_target_key: resolveTargetKey(context, settings.sourceNodeId),
    p_automation_id: context.automationId,
    p_automation_key: buildAutomationKey({
      automationId: context.automationId,
      version: context.version,
      eventId: context.eventId,
      nodeId: context.nodeId,
    }),
    p_subject: subject,
    p_description: description,
    p_priority: settings.priority === "" ? null : settings.priority,
    p_due_date: settings.due_date === "" ? null : settings.due_date,
    p_type: settings.type === "" ? null : settings.type,
    p_status: settings.status === "" ? null : settings.status,
    p_assign_owner: assignOwner,
    p_assignment_mode: assignOwner ? settings.assignmentMode : "Fixed",
    p_fixed_assignee: assignOwner && settings.assignmentMode === "Fixed" ? settings.assigneeId : null,
    p_round_robin_pool: assignOwner && settings.assignmentMode === "RoundRobin" ? settings.rotation : [],
    // LINEAGE — see createTask's identical note.
    p_root_event_id: context.rootEventId,
    p_correlation_id: context.correlationId,
    p_depth: context.depth,
  });

  if (error) {
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  switch (data as string) {
    case "updated":
      return { ok: true, detail: "Task updated.", retryable: false };
    case "duplicate":
      return { ok: true, detail: "Task already updated for this event.", retryable: false, deduplicated: true };
    case "target_not_found":
      return targetNotFoundOutcome("Task", "update");
    case "record_inactive":
      return { ok: false, detail: "That task has been deactivated and can no longer be changed.", retryable: false };
    case "no_eligible_assignee":
      return { ok: false, detail: "Nobody this task could be assigned to is still an active member.", retryable: false };
    case "invalid_automation":
      return { ok: false, detail: "This automation could not be found for this organisation.", retryable: false };
    case "automation_not_active":
      return { ok: false, detail: "This automation was switched off before the task could be updated.", retryable: false };
    case "invalid_subject":
      return { ok: false, detail: "The configured subject is not valid.", retryable: false };
    case "invalid_priority":
      return { ok: false, detail: "The configured priority is not valid.", retryable: false };
    case "invalid_type":
      return { ok: false, detail: "The configured type is not valid.", retryable: false };
    case "invalid_status":
      return { ok: false, detail: "The configured status is not valid.", retryable: false };
    case "unauthorized":
      return { ok: false, detail: "The automation worker is not authorised.", retryable: true };
    default:
      return { ok: false, detail: `Task update was refused: ${String(data)}.`, retryable: false };
  }
};

const updateContact: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_CONTACT_UPDATE);
  if (!entry) {
    return { ok: false, detail: "The update-contact action is not registered.", retryable: false };
  }

  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Update-contact settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as {
    sourceNodeId: string;
    name: string;
    company: string;
    title: string;
    email: string;
    phone: string;
    assignmentMode: "None" | "Fixed" | "RoundRobin";
    assigneeId: string | null;
    rotation: string[];
  };

  const assignOwner = settings.assignmentMode !== "None";

  const { data, error } = await context.supabase.rpc("update_contact_via_automation", {
    p_token: context.workerToken,
    p_customer_id: context.customerId,
    p_target_key: resolveTargetKey(context, settings.sourceNodeId),
    p_automation_id: context.automationId,
    p_automation_key: buildAutomationKey({
      automationId: context.automationId,
      version: context.version,
      eventId: context.eventId,
      nodeId: context.nodeId,
    }),
    p_name: settings.name === "" ? null : settings.name,
    p_company: settings.company === "" ? null : settings.company,
    p_title: settings.title === "" ? null : settings.title,
    p_email: settings.email === "" ? null : settings.email,
    p_phone: settings.phone === "" ? null : settings.phone,
    p_assign_owner: assignOwner,
    p_assignment_mode: assignOwner ? settings.assignmentMode : "Fixed",
    p_fixed_assignee: assignOwner && settings.assignmentMode === "Fixed" ? settings.assigneeId : null,
    p_round_robin_pool: assignOwner && settings.assignmentMode === "RoundRobin" ? settings.rotation : [],
    // LINEAGE — see createTask's identical note.
    p_root_event_id: context.rootEventId,
    p_correlation_id: context.correlationId,
    p_depth: context.depth,
  });

  if (error) {
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  switch (data as string) {
    case "updated":
      return { ok: true, detail: "Contact updated.", retryable: false };
    case "duplicate":
      return { ok: true, detail: "Contact already updated for this event.", retryable: false, deduplicated: true };
    case "target_not_found":
      return targetNotFoundOutcome("Contact", "update");
    case "record_inactive":
      return { ok: false, detail: "That contact has been deactivated and can no longer be changed.", retryable: false };
    case "no_eligible_assignee":
      return { ok: false, detail: "Nobody this contact could be assigned to is still an active member.", retryable: false };
    case "invalid_automation":
      return { ok: false, detail: "This automation could not be found for this organisation.", retryable: false };
    case "automation_not_active":
      return { ok: false, detail: "This automation was switched off before the contact could be updated.", retryable: false };
    case "invalid_name":
      return { ok: false, detail: "The configured contact name is not valid.", retryable: false };
    case "unauthorized":
      return { ok: false, detail: "The automation worker is not authorised.", retryable: true };
    default:
      return { ok: false, detail: `Contact update was refused: ${String(data)}.`, retryable: false };
  }
};

const deactivateTask: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_TASK_DEACTIVATE);
  if (!entry) {
    return { ok: false, detail: "The deactivate-task action is not registered.", retryable: false };
  }

  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Deactivate-task settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as { sourceNodeId: string };

  const { data, error } = await context.supabase.rpc("deactivate_task_via_automation", {
    p_token: context.workerToken,
    p_customer_id: context.customerId,
    p_target_key: resolveTargetKey(context, settings.sourceNodeId),
    p_automation_id: context.automationId,
    p_automation_key: buildAutomationKey({
      automationId: context.automationId,
      version: context.version,
      eventId: context.eventId,
      nodeId: context.nodeId,
    }),
    // LINEAGE — see createTask's identical note.
    p_root_event_id: context.rootEventId,
    p_correlation_id: context.correlationId,
    p_depth: context.depth,
  });

  if (error) {
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  switch (data as string) {
    case "deactivated":
      return { ok: true, detail: "Task deactivated.", retryable: false };
    case "duplicate":
      return { ok: true, detail: "Task already deactivated for this event.", retryable: false, deduplicated: true };
    case "target_not_found":
      return targetNotFoundOutcome("Task", "deactivate");
    case "invalid_automation":
      return { ok: false, detail: "This automation could not be found for this organisation.", retryable: false };
    case "automation_not_active":
      return { ok: false, detail: "This automation was switched off before the task could be deactivated.", retryable: false };
    case "unauthorized":
      return { ok: false, detail: "The automation worker is not authorised.", retryable: true };
    default:
      return { ok: false, detail: `Task deactivation was refused: ${String(data)}.`, retryable: false };
  }
};

const deactivateContact: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_CONTACT_DEACTIVATE);
  if (!entry) {
    return { ok: false, detail: "The deactivate-contact action is not registered.", retryable: false };
  }

  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Deactivate-contact settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as { sourceNodeId: string };

  const { data, error } = await context.supabase.rpc("deactivate_contact_via_automation", {
    p_token: context.workerToken,
    p_customer_id: context.customerId,
    p_target_key: resolveTargetKey(context, settings.sourceNodeId),
    p_automation_id: context.automationId,
    p_automation_key: buildAutomationKey({
      automationId: context.automationId,
      version: context.version,
      eventId: context.eventId,
      nodeId: context.nodeId,
    }),
    // LINEAGE — see createTask's identical note.
    p_root_event_id: context.rootEventId,
    p_correlation_id: context.correlationId,
    p_depth: context.depth,
  });

  if (error) {
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  switch (data as string) {
    case "deactivated":
      return { ok: true, detail: "Contact deactivated.", retryable: false };
    case "duplicate":
      return { ok: true, detail: "Contact already deactivated for this event.", retryable: false, deduplicated: true };
    case "target_not_found":
      return targetNotFoundOutcome("Contact", "deactivate");
    case "invalid_automation":
      return { ok: false, detail: "This automation could not be found for this organisation.", retryable: false };
    case "automation_not_active":
      return { ok: false, detail: "This automation was switched off before the contact could be deactivated.", retryable: false };
    case "unauthorized":
      return { ok: false, detail: "The automation worker is not authorised.", retryable: true };
    default:
      return { ok: false, detail: `Contact deactivation was refused: ${String(data)}.`, retryable: false };
  }
};

/**
 * Get Records — the first read-only step in this registry.
 *
 * Fetches up to MAX_RECORDS_PER_QUERY of this tenant's own most-recent
 * rows for the chosen object (get_automation_records — see that
 * migration's own design notes for exactly how tenant isolation is
 * guaranteed there), then filters them HERE, in TypeScript, with
 * evaluateFieldGroup — the identical AND/OR engine a Decision or
 * Condition node already runs, just pointed at whichever object's field
 * registry was picked (object-fields.ts) instead of always Lead's. No
 * second filter language, no SQL built from the filter.
 *
 * Writes its result into context.recordVariables — the ONLY place in
 * this file that does. See ActionContext's own note on why that map
 * cannot be populated any earlier than this (a live query cannot happen
 * inside planWorkflow, which is pure).
 */
const getRecords: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_GET_RECORDS);
  if (!entry) {
    return { ok: false, detail: "The get-records action is not registered.", retryable: false };
  }

  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Get Records settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as {
    object: TriggerObject;
    filters: ConditionGroup;
    limit: number;
    resultVariable: string;
  };

  const { data, error } = await context.supabase.rpc("get_automation_records", {
    p_token: context.workerToken,
    p_customer_id: context.customerId,
    p_object: settings.object,
    p_limit: settings.limit,
  });

  if (error) {
    return { ok: false, detail: `Database error (code ${error.code ?? "unknown"}).`, retryable: true };
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{ record_json: Record<string, unknown> }>;
  const registry = fieldRegistryForObject(settings.object);
  const getFieldDef = (key: string) => registry.find((field) => field.key === key);

  const matched = rows
    .map((row) => row.record_json)
    .filter((record) => evaluateFieldGroup(settings.filters, record, getFieldDef));

  context.recordVariables.set(settings.resultVariable, {
    kind: "collection",
    object: settings.object,
    records: matched,
  });

  return { ok: true, detail: `Found ${matched.length} matching ${settings.object} record(s).`, retryable: false };
};

/**
 * A closed, {{item.*}}-only substitution — deliberately a second,
 * separate pass from renderTemplate's {{lead.*}} and planWorkflow's own
 * {{var.*}}, not a merge of all three into one engine. `{{var.*}}` is
 * resolved once, at PLAN time, before this action's config is even
 * built (see planWorkflow's own note on capturing a Loop's body); this
 * one runs at EXECUTION time, once per iteration, because the current
 * item cannot exist any earlier than that. The two prefixes can never
 * collide (var. vs item.), so running this second pass over a config
 * that already had {{var.*}} resolved is safe — there is nothing left
 * for it to accidentally re-substitute.
 */
function substituteItemTokens(config: Record<string, unknown>, itemVariable: string, item: Record<string, unknown>): Record<string, unknown> {
  const prefix = `{{${itemVariable}.`;
  const json = JSON.stringify(config);
  if (!json.includes(prefix)) return config;

  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      let out = value;
      for (const [key, fieldValue] of Object.entries(item)) {
        const token = `${prefix}${key}}}`;
        if (out.includes(token)) {
          const replacement =
            fieldValue === null || fieldValue === undefined
              ? ""
              : typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean"
                ? String(fieldValue)
                : "";
          out = out.split(token).join(replacement);
        }
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  }

  return walk(config) as Record<string, unknown>;
}

/**
 * Loop — runs its own single body action once per item in a collection
 * an earlier Get Records step produced, up to MAX_LOOP_ITERATIONS.
 *
 * PLAN-TIME UNROLLING WAS CONSIDERED AND REJECTED: it would need the
 * collection to already be known when planWorkflow runs, but a
 * collection can only come from a REAL DATABASE QUERY (Get Records),
 * which planWorkflow — deliberately pure, no IO — cannot perform. So
 * Loop is a normal, single PlannedAction, like any other, and this
 * executor is where its iterations actually happen — reusing the
 * EXISTING sequential executor dispatch (getActionExecutor) once per
 * item, not a new interpreter.
 *
 * HOW THIS COMPOSES WITH MAX_ACTIONS_PER_EVENT, NOT AROUND IT: engine.ts
 * computes context.remainingActionBudget (MAX_ACTIONS_PER_EVENT minus
 * every action already executed in this event's lineage, across every
 * automation) BEFORE calling any executor, including this one. Every
 * iteration below is checked against that SAME number before it runs,
 * and the outcome reports back exactly how many iterations actually
 * executed (`actionsPerformed`) so engine.ts charges the shared ceiling
 * for the real work done — a Loop over a 500-item collection cannot
 * spend more of the event's shared budget than is actually left, and
 * MAX_LOOP_ITERATIONS caps it independently, tighter, regardless of how
 * much budget remains. Neither limit can be used to bypass the other,
 * because both are checked against the identical running totals every
 * other action in this event already is — a loop is not a separate
 * execution context the existing safeguards cannot see, it is the same
 * flat action-per-event accounting, just charged for more than one unit
 * from a single executor call.
 *
 * Stops at the FIRST body failure, exactly like the outer engine stops
 * at the first failing action in a plain sequence — a partial loop
 * (some items succeeded, then one failed) is reported as a failure, and
 * the iterations that DID succeed before that point are, conservatively,
 * not credited against the budget (engine.ts only reads
 * actionsPerformed on an ok:true outcome) — the one place this design
 * is deliberately imprecise rather than more complex, and only ever in
 * the safe direction (undercounting), bounded in the worst case by
 * MAX_LOOP_ITERATIONS itself.
 */
const loop: Executor = async (context, config) => {
  const entry = getRegistryEntry(ACTION_LOOP);
  if (!entry) {
    return { ok: false, detail: "The loop action is not registered.", retryable: false };
  }

  const parsed = entry.configSchema.safeParse(config);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `Loop settings are not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      retryable: false,
    };
  }

  const settings = parsed.data as { collectionVariable: string; itemVariable: string };
  const bodyAction = (config as { bodyAction?: { type: string; config: Record<string, unknown> } }).bodyAction;

  if (!bodyAction) {
    // Reachable only if validate-workflow's own check (a Loop must have
    // exactly one outgoing edge, to a real action) was somehow bypassed
    // — the builder never lets this save otherwise.
    return { ok: false, detail: "This Loop has no step connected to run.", retryable: false };
  }

  const collection = context.recordVariables.get(settings.collectionVariable);
  if (!collection || collection.kind !== "collection") {
    return {
      ok: false,
      detail: `"${settings.collectionVariable}" was never set by a Get Records step in this run — nothing to loop through.`,
      retryable: false,
    };
  }

  const bodyExecutor = getActionExecutor(bodyAction.type);
  if (!bodyExecutor) {
    return { ok: false, detail: `"${bodyAction.type}" is not an action this app can perform.`, retryable: false };
  }

  const items = collection.records.slice(0, MAX_LOOP_ITERATIONS);
  let performed = 0;

  for (const item of items) {
    if (performed >= context.remainingActionBudget) {
      return {
        ok: true,
        detail: `Stopped after ${performed} of ${items.length}: the shared per-event action limit was reached.`,
        retryable: false,
        actionsPerformed: performed,
      };
    }

    const itemConfig = substituteItemTokens(bodyAction.config, settings.itemVariable, item);
    const outcome = await bodyExecutor(
      { ...context, remainingActionBudget: context.remainingActionBudget - performed },
      itemConfig,
    );

    if (!outcome.ok) {
      return {
        ok: false,
        detail: `Stopped after ${performed} of ${items.length}: ${outcome.detail}`,
        retryable: outcome.retryable,
      };
    }
    if (!outcome.deduplicated) {
      performed += outcome.actionsPerformed ?? 1;
    }
  }

  return { ok: true, detail: `Ran ${performed} time(s).`, retryable: false, actionsPerformed: performed };
};

/**
 * The dispatch table. An action key with no entry here cannot run — the
 * engine reports it and stops rather than guessing, which is what keeps
 * "the registry is the menu" true at execution time and not just at
 * authoring time.
 */
const EXECUTORS: Record<string, Executor> = {
  [ACTION_TASK_CREATE]: createTask,
  [ACTION_LEAD_UPDATE]: updateLead,
  [ACTION_CONTACT_CREATE]: createContact,
  [ACTION_TASK_UPDATE]: updateTask,
  [ACTION_CONTACT_UPDATE]: updateContact,
  [ACTION_TASK_DEACTIVATE]: deactivateTask,
  [ACTION_CONTACT_DEACTIVATE]: deactivateContact,
  [ACTION_LEAD_DEACTIVATE]: deactivateLead,
  [ACTION_GET_RECORDS]: getRecords,
  [ACTION_LOOP]: loop,
};

export function getActionExecutor(key: string): Executor | undefined {
  return EXECUTORS[key];
}
