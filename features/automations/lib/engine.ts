import { createWebhookClient } from "@/lib/supabase/webhook";
import {
  EVENT_BATCH_SIZE,
  MAX_RETRIES_PER_EVENT,
  MIN_WORKER_TOKEN_LENGTH,
  PROCESSING_TIMEOUT_SECONDS,
} from "../config/safeguards";
import { getActionExecutor } from "../registry/executors";
import {
  checkActionBudget,
  checkActionBudgetMidRun,
  checkAncestry,
  checkEventDepth,
} from "./safeguards-check";
import { planWorkflow, type LeadFacts } from "./plan-workflow";
import { validateWorkflow } from "./validate-workflow";
import type { WorkflowDefinition } from "@/types/automation";

/**
 * THE EXECUTION ENGINE. One path, one set of limits, one set of checks.
 *
 * There is no branch anywhere in this file — or in anything it calls —
 * that reads how an automation was authored. `origin` is recorded on the
 * row for history and is not selected by any query the engine makes, so
 * an AI-generated workflow is not merely treated the same as a
 * hand-built one: at this layer the distinction is not even
 * representable.
 *
 * Runs with NO USER SESSION. Everything it touches goes through a
 * token-gated SECURITY DEFINER function (see the migration's design note
 * 2) — it holds no service-role key, and the anon client it uses has no
 * table grants of its own.
 *
 * EVERY LIMIT IS IMPORTED. Not one number below is typed in place.
 */

export type ProcessResult = {
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  stopped: number;
  actionsExecuted: number;
  /** Non-sensitive lines for the cron response and the server log. */
  notes: string[];
};

type ClaimedEvent = {
  id: string;
  customer_id: string;
  event_type: string;
  subject_id: string;
  root_event_id: string;
  correlation_id: string;
  depth: number;
  attempts: number;
  payload: Record<string, unknown>;
  /** THIS worker's ownership of THIS claim. Minted by
   *  claim_automation_events and required back by
   *  complete_automation_event and record_automation_run — a worker whose
   *  claim was reclaimed while it was still running no longer matches,
   *  and its writes are refused instead of overwriting whoever owns the
   *  event now. */
  claim_token: string;
};

type ActiveAutomation = {
  automation_id: string;
  version_id: string;
  version: number;
  name: string;
  trigger_type: string;
  definition: WorkflowDefinition;
};

/** Thrown for the one condition the engine cannot work around. Surfaced
 *  as a distinct HTTP status by the route handler so a missing
 *  environment variable reads as a setup problem, not as a bug. */
export class WorkerNotConfiguredError extends Error {}

function getWorkerToken(): string {
  const token = process.env.AUTOMATION_WORKER_TOKEN;
  if (!token || token.length < MIN_WORKER_TOKEN_LENGTH) {
    throw new WorkerNotConfiguredError(
      "AUTOMATION_WORKER_TOKEN is not set. Read it once from the database with " +
        "`select token from public.automation_worker_config;` and set it in the environment.",
    );
  }
  return token;
}

/**
 * Claim and process one bounded batch.
 *
 * Bounded on purpose: a cron invocation has a wall-clock limit, and an
 * unbounded drain would be killed partway through, leaving rows in
 * `processing` for the stale-recovery path to clean up. Taking
 * EVENT_BATCH_SIZE at a time means a backlog is worked off across
 * several invocations instead of one that never finishes.
 */
export async function processAutomationEvents(): Promise<ProcessResult> {
  const workerToken = getWorkerToken();
  const supabase = createWebhookClient();

  const result: ProcessResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    stopped: 0,
    actionsExecuted: 0,
    notes: [],
  };

  const { data: claimed, error: claimError } = await supabase.rpc("claim_automation_events", {
    p_token: workerToken,
    p_batch_size: EVENT_BATCH_SIZE,
    p_timeout_seconds: PROCESSING_TIMEOUT_SECONDS,
    p_max_attempts: MAX_RETRIES_PER_EVENT,
  });

  if (claimError) {
    console.error(`[automations] claim failed (code: ${claimError.code ?? "unknown"}).`);
    throw new Error("Could not claim automation events.");
  }

  const events = (claimed ?? []) as ClaimedEvent[];
  result.claimed = events.length;

  // Sequential, not Promise.all. Two events for the same tenant can
  // resolve the same round-robin rotation, and the rotation cursor is
  // advanced under a row lock — running them concurrently would have
  // them queue on that lock anyway, while making the failure of one
  // harder to attribute. Throughput comes from the batch size and the
  // cron frequency, not from racing within a batch.
  for (const event of events) {
    try {
      await processEvent(supabase, workerToken, event, result);
    } catch (error) {
      // One event must never take the batch down with it.
      result.failed += 1;
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`[automations] event ${event.id} threw: ${detail}`);
      await release(supabase, workerToken, event, "failed", detail, true);
    }
  }

  return result;
}

async function processEvent(
  supabase: ReturnType<typeof createWebhookClient>,
  workerToken: string,
  event: ClaimedEvent,
  result: ProcessResult,
): Promise<void> {
  // ---- SAFEGUARD 1: depth -------------------------------------------
  // Bounds the CHAIN case. Checked before anything is read, because an
  // over-deep event should cost one comparison, not a query.
  //
  // UNREACHABLE IN v1 (the migration's design note 6): creating a task
  // raises no event, so nothing can currently arrive at depth > 0. It is
  // enforced anyway — the cost is one comparison, and the alternative is
  // retrofitting it onto a live outbox later.
  const depthVerdict = checkEventDepth(event.depth);
  if (!depthVerdict.allowed) {
    result.stopped += 1;
    await release(supabase, workerToken, event, "failed", depthVerdict.reason, false);
    return;
  }

  const { data: automationRows, error: automationError } = await supabase.rpc("get_active_automations", {
    p_token: workerToken,
    p_customer_id: event.customer_id,
    p_trigger_type: event.event_type,
  });

  if (automationError) {
    throw new Error(`could not load automations (code ${automationError.code ?? "unknown"})`);
  }

  const automations = (automationRows ?? []) as ActiveAutomation[];
  if (automations.length === 0) {
    // The automation was deactivated between the trigger enqueueing this
    // event and a worker reaching it. Not a failure — there is simply
    // nothing to do, and the event is closed rather than retried.
    result.skipped += 1;
    await release(supabase, workerToken, event, "succeeded", null, false);
    return;
  }

  const facts = await loadLeadFacts(supabase, workerToken, event);
  if (!facts) {
    result.failed += 1;
    await release(
      supabase,
      workerToken,
      event,
      "failed",
      "The lead this event refers to could not be read.",
      false,
    );
    return;
  }

  // Lineage, read ONCE per event and then carried forward in memory. The
  // per-event action ceiling has to account for what this batch is about
  // to do as well as what earlier runs already did, so the running total
  // below starts from history and grows as actions execute.
  const { data: lineageRows } = await supabase.rpc("get_automation_lineage", {
    p_token: workerToken,
    p_root_event_id: event.root_event_id,
  });
  const lineage = (Array.isArray(lineageRows) ? lineageRows[0] : lineageRows) as
    | { actions_executed: number; automation_ids: string[] }
    | undefined;

  let actionsSoFar = lineage?.actions_executed ?? 0;
  const ancestry = new Set(lineage?.automation_ids ?? []);

  const todayIso = new Date().toISOString().slice(0, 10);
  let anyFailure = false;
  let anyRetryable = false;

  for (const automation of automations) {
    // ---- SAFEGUARD 2: automation ancestry ---------------------------
    // If this automation has already run somewhere in this root event's
    // lineage, running it again is a cycle by definition — whatever
    // route the event took to get back here.
    const ancestryVerdict = checkAncestry(automation.automation_id, ancestry);
    if (!ancestryVerdict.allowed) {
      result.stopped += 1;
      await recordRun(supabase, workerToken, event, automation, {
        status: "stopped_by_safeguard",
        stopReason: ancestryVerdict.reason,
        actionsExecuted: 0,
      });
      continue;
    }

    // ---- SAFEGUARD 3: actions per root event ------------------------
    const budgetVerdict = checkActionBudget(actionsSoFar);
    if (!budgetVerdict.allowed) {
      result.stopped += 1;
      await recordRun(supabase, workerToken, event, automation, {
        status: "stopped_by_safeguard",
        stopReason: budgetVerdict.reason,
        actionsExecuted: 0,
      });
      continue;
    }

    // A STORED DEFINITION IS UNTRUSTED INPUT. It passed validation when
    // it was saved, but the rules may have tightened since, and this is
    // the last moment before something real happens.
    const validation = validateWorkflow(automation.definition);
    if (!validation.ok) {
      anyFailure = true;
      result.failed += 1;
      await recordRun(supabase, workerToken, event, automation, {
        status: "failed",
        errorDetail: `This workflow is no longer valid: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        actionsExecuted: 0,
      });
      continue;
    }

    const plan = planWorkflow(automation.definition, facts);

    if (!plan.triggered) {
      result.skipped += 1;
      await recordRun(supabase, workerToken, event, automation, {
        status: "skipped",
        stopReason: plan.trace[plan.trace.length - 1] ?? "The trigger's filter did not match this lead.",
        actionsExecuted: 0,
      });
      continue;
    }

    let executed = 0;
    let runFailed = false;
    let runError: string | null = null;

    for (const action of plan.actions) {
      // Re-checked INSIDE the loop, not just before it: a workflow with
      // several actions must not be able to overshoot the ceiling by the
      // width of its own action list.
      const midRunVerdict = checkActionBudgetMidRun(actionsSoFar);
      if (!midRunVerdict.allowed) {
        result.stopped += 1;
        await recordRun(supabase, workerToken, event, automation, {
          status: "stopped_by_safeguard",
          stopReason: midRunVerdict.reason,
          actionsExecuted: executed,
        });
        runFailed = true;
        break;
      }

      const executor = getActionExecutor(action.type);
      if (!executor) {
        runFailed = true;
        runError = `"${action.type}" is not an action this app can perform.`;
        break;
      }

      const outcome = await executor(
        {
          supabase,
          workerToken,
          customerId: event.customer_id,
          leadId: event.subject_id,
          automationId: automation.automation_id,
          version: automation.version,
          eventId: event.id,
          nodeId: action.nodeId,
          facts,
          todayIso,
        },
        action.config,
      );

      if (!outcome.ok) {
        runFailed = true;
        runError = outcome.detail;
        anyRetryable = anyRetryable || outcome.retryable;
        break;
      }

      // A suppressed duplicate is a success that did no work, so it does
      // not consume the per-event budget — otherwise a retry would eat
      // the allowance of actions that never actually happened.
      if (!outcome.deduplicated) {
        executed += 1;
        actionsSoFar += 1;
        result.actionsExecuted += 1;
      }
    }

    if (runFailed) {
      anyFailure = true;
      result.failed += 1;
      await recordRun(supabase, workerToken, event, automation, {
        status: "failed",
        errorDetail: runError ?? "The workflow stopped before finishing.",
        actionsExecuted: executed,
      });
      continue;
    }

    result.succeeded += 1;
    // Marked as run for this root event's lineage, so a later automation
    // in the same batch sees it in `ancestry` without another round trip.
    ancestry.add(automation.automation_id);
    await recordRun(supabase, workerToken, event, automation, {
      status: "succeeded",
      actionsExecuted: executed,
    });
  }

  await release(
    supabase,
    workerToken,
    event,
    anyFailure ? "failed" : "succeeded",
    anyFailure ? "At least one automation did not complete. See the run history." : null,
    anyFailure && anyRetryable,
  );
}

async function loadLeadFacts(
  supabase: ReturnType<typeof createWebhookClient>,
  workerToken: string,
  event: ClaimedEvent,
): Promise<LeadFacts | null> {
  const { data, error } = await supabase.rpc("get_automation_lead_facts", {
    p_token: workerToken,
    p_customer_id: event.customer_id,
    p_lead_id: event.subject_id,
  });

  const row = (Array.isArray(data) ? data[0] : data) as
    | { company: string; contact_name: string; source: string | null; has_owner: boolean }
    | undefined;

  if (error || !row) {
    return null;
  }

  return {
    leadId: event.subject_id,
    // THE SNAPSHOT WINS for the trigger-relevant fields. The event
    // payload recorded what was true when the lead was created; an
    // admin's "only IndiaMART leads" rule has to mean the lead ARRIVED
    // from IndiaMART, not that its source column still says so by the
    // time a worker reached it. The display fields below come from the
    // live row, because a task should name the company as it is now.
    source: typeof event.payload.source === "string" ? event.payload.source : row.source,
    hasOwner: typeof event.payload.owner_id === "string" ? true : row.has_owner,
    company: row.company,
    contactName: row.contact_name,
  };
}

async function recordRun(
  supabase: ReturnType<typeof createWebhookClient>,
  workerToken: string,
  event: ClaimedEvent,
  automation: ActiveAutomation,
  outcome: {
    status: "succeeded" | "failed" | "skipped" | "stopped_by_safeguard";
    stopReason?: string;
    errorDetail?: string;
    actionsExecuted: number;
  },
): Promise<void> {
  // EVERY OUTCOME IS RECORDED, including every safeguard stop and every
  // skip. An automation that silently does nothing is indistinguishable
  // from one that is broken, and with nobody watching, "indistinguishable"
  // means "unnoticed".
  const { error } = await supabase.rpc("record_automation_run", {
    p_token: workerToken,
    p_customer_id: event.customer_id,
    p_automation_id: automation.automation_id,
    p_version_id: automation.version_id,
    p_event_id: event.id,
    p_claim_token: event.claim_token,
    p_root_event_id: event.root_event_id,
    p_correlation_id: event.correlation_id,
    p_status: outcome.status,
    p_stop_reason: outcome.stopReason ?? null,
    p_error_detail: outcome.errorDetail ?? null,
    p_actions_executed: outcome.actionsExecuted,
  });

  if (error) {
    console.error(`[automations] could not record run (code: ${error.code ?? "unknown"}).`);
  }
}

async function release(
  supabase: ReturnType<typeof createWebhookClient>,
  workerToken: string,
  event: Pick<ClaimedEvent, "id" | "claim_token">,
  status: "succeeded" | "failed",
  error: string | null,
  retryable: boolean,
): Promise<void> {
  const eventId = event.id;
  const { data, error: rpcError } = await supabase.rpc("complete_automation_event", {
    p_token: workerToken,
    p_event_id: eventId,
    p_claim_token: event.claim_token,
    p_status: status,
    p_error: error,
    p_retryable: retryable,
  });

  if (rpcError) {
    console.error(`[automations] could not release event ${eventId} (code: ${rpcError.code ?? "unknown"}).`);
    return;
  }

  if (data === "not_claimed") {
    // THIS WORKER NO LONGER OWNS THE EVENT. Stale recovery reclaimed it
    // while this worker was still running — the run took longer than
    // PROCESSING_TIMEOUT_SECONDS — and another worker now holds it.
    //
    // The refusal is the correct outcome, not an error to recover from:
    // without it this worker would have closed out an event that is
    // actively being processed elsewhere, so a genuine failure could be
    // recorded as a success. Logged because it means the timeout is
    // tuned too tight for the workload, which nothing else would
    // surface.
    console.warn(
      `[automations] event ${eventId} was no longer claimed by this worker on release; ` +
        `its write was refused. It ran longer than the ${PROCESSING_TIMEOUT_SECONDS}s processing timeout, ` +
        "so another worker has taken it over (the idempotency key and the unique run constraint make that " +
        "safe, but it is wasted work).",
    );
  }
}
