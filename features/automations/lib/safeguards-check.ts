import { MAX_ACTIONS_PER_EVENT, MAX_WORKFLOW_DEPTH } from "../config/safeguards";

/**
 * THE LOOP SAFEGUARD DECISIONS, as pure functions.
 *
 * Extracted from the engine deliberately. In v1 the only trigger is
 * lead.created and the only action is task.create — and creating a task
 * raises no event, so NO CYCLE CAN ACTUALLY FORM. That means the
 * safeguards below cannot be exercised by any workflow an admin is able
 * to build today, whether by hand or through the AI builder.
 *
 * Rather than claim a cycle test that cannot honestly be run, the
 * decisions are pulled out here so they can be tested directly, on
 * their own terms, with inputs a real event would carry. The engine
 * calls exactly these functions — there is no second copy of the rule
 * living inside it that the tests would miss.
 *
 * The limitation is real and is stated in the feature's own
 * documentation: these are verified by unit test, not by an end-to-end
 * cycle, because v1's capability set makes an end-to-end cycle
 * impossible to construct.
 *
 * Every bound is imported from config/safeguards.ts. Nothing here types
 * a number.
 */

export type SafeguardVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: SafeguardVerdict = { allowed: true };

/**
 * Bounds the CHAIN case: an action producing an event that triggers
 * another automation, whose action produces another event, and so on.
 *
 * Depth 0 is an event the application itself raised. Anything deeper was
 * caused by an automation.
 */
export function checkEventDepth(depth: number): SafeguardVerdict {
  if (depth > MAX_WORKFLOW_DEPTH) {
    return {
      allowed: false,
      reason: `Stopped: exceeded the maximum workflow depth of ${MAX_WORKFLOW_DEPTH}.`,
    };
  }
  return ALLOWED;
}

/**
 * Bounds the FAN-OUT case: many automations all responding to the same
 * originating event.
 *
 * Counted per ROOT EVENT and shared across every automation descended
 * from it, so adding an eleventh automation cannot quietly raise the
 * ceiling — which is the whole reason it is not counted per automation.
 */
export function checkActionBudget(actionsSoFar: number): SafeguardVerdict {
  if (actionsSoFar >= MAX_ACTIONS_PER_EVENT) {
    return {
      allowed: false,
      reason: `The limit of ${MAX_ACTIONS_PER_EVENT} actions for one triggering event had already been reached.`,
    };
  }
  return ALLOWED;
}

/**
 * Catches a cycle by LINEAGE rather than by counting.
 *
 * If this automation has already run somewhere in this root event's
 * ancestry, running it again is a cycle by definition — whatever route
 * the event took to come back around. This is the check that stops a
 * loop on its second pass instead of on its tenth, and it does not
 * depend on the loop being short enough to notice or long enough to
 * exhaust a budget.
 */
export function checkAncestry(automationId: string, ancestry: ReadonlySet<string>): SafeguardVerdict {
  if (ancestry.has(automationId)) {
    return {
      allowed: false,
      reason: "This automation had already run for the event that started this chain.",
    };
  }
  return ALLOWED;
}

/** Mid-run re-check, so a workflow holding several actions cannot
 *  overshoot the ceiling by the width of its own action list. */
export function checkActionBudgetMidRun(actionsSoFar: number): SafeguardVerdict {
  if (actionsSoFar >= MAX_ACTIONS_PER_EVENT) {
    return {
      allowed: false,
      reason: `Stopped part-way: the limit of ${MAX_ACTIONS_PER_EVENT} actions for one triggering event was reached.`,
    };
  }
  return ALLOWED;
}
