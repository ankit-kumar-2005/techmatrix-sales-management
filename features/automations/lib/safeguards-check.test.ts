import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ACTIONS_PER_EVENT,
  MAX_WORKFLOW_DEPTH,
} from "../config/safeguards";
import {
  checkActionBudget,
  checkActionBudgetMidRun,
  checkAncestry,
  checkEventDepth,
} from "./safeguards-check";

/**
 * THE LOOP SAFEGUARDS.
 *
 * READ THIS BEFORE TRUSTING THESE TESTS. In v1 the only trigger is
 * lead.created and the only action is task.create. Creating a task does
 * not create a lead, so no action can raise an event, so NO CYCLE CAN
 * BE CONSTRUCTED — not by hand in the builder, and not by the AI
 * builder either. An end-to-end "deliberately build a loop and watch it
 * be stopped" test therefore cannot honestly be written against this
 * release, and none is claimed.
 *
 * What is verified instead is the decision itself, directly, with the
 * inputs a real event would carry. The engine calls exactly these four
 * functions — there is no second copy of any of these rules inside it —
 * so a passing test here means the engine's behaviour at those
 * boundaries is the behaviour asserted below. What remains unverified is
 * the wiring from a real second-generation event into them, because no
 * such event can exist yet.
 *
 * Every bound is read from config/safeguards.ts rather than written out,
 * so raising a limit does not silently make a test vacuous.
 */

describe("checkEventDepth", () => {
  it("allows an event the application itself raised", () => {
    assert.equal(checkEventDepth(0).allowed, true);
  });

  it("allows depth right up to the limit", () => {
    assert.equal(checkEventDepth(MAX_WORKFLOW_DEPTH).allowed, true);
  });

  it("stops one past the limit, and names the limit in the reason", () => {
    const verdict = checkEventDepth(MAX_WORKFLOW_DEPTH + 1);
    assert.equal(verdict.allowed, false);
    assert.ok(!verdict.allowed && verdict.reason.includes(String(MAX_WORKFLOW_DEPTH)));
  });

  it("stops a runaway chain far past the limit", () => {
    assert.equal(checkEventDepth(MAX_WORKFLOW_DEPTH + 1000).allowed, false);
  });
});

describe("checkActionBudget", () => {
  it("allows a root event that has done nothing yet", () => {
    assert.equal(checkActionBudget(0).allowed, true);
  });

  it("allows the last action inside the budget", () => {
    assert.equal(checkActionBudget(MAX_ACTIONS_PER_EVENT - 1).allowed, true);
  });

  it("stops exactly AT the limit, not one past it", () => {
    // The budget counts what has ALREADY happened, so reaching the limit
    // means the allowance is spent — an off-by-one here would let one
    // extra write through on every root event.
    const verdict = checkActionBudget(MAX_ACTIONS_PER_EVENT);
    assert.equal(verdict.allowed, false);
    assert.ok(!verdict.allowed && verdict.reason.includes(String(MAX_ACTIONS_PER_EVENT)));
  });

  it("stops well past the limit", () => {
    assert.equal(checkActionBudget(MAX_ACTIONS_PER_EVENT * 10).allowed, false);
  });
});

describe("checkActionBudgetMidRun", () => {
  it("uses the same boundary as the pre-run check", () => {
    // The two differ only in wording — the mid-run one says "stopped
    // part-way". If they ever disagreed on the NUMBER, a workflow with
    // several actions could overshoot by the width of its own action
    // list, which is the exact bug the mid-run check exists to prevent.
    assert.equal(
      checkActionBudgetMidRun(MAX_ACTIONS_PER_EVENT - 1).allowed,
      checkActionBudget(MAX_ACTIONS_PER_EVENT - 1).allowed,
    );
    assert.equal(
      checkActionBudgetMidRun(MAX_ACTIONS_PER_EVENT).allowed,
      checkActionBudget(MAX_ACTIONS_PER_EVENT).allowed,
    );
  });

  it("stops part-way through a multi-action workflow", () => {
    const verdict = checkActionBudgetMidRun(MAX_ACTIONS_PER_EVENT);
    assert.equal(verdict.allowed, false);
    assert.ok(!verdict.allowed && verdict.reason.toLowerCase().includes("part-way"));
  });
});

describe("checkAncestry", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";

  it("allows an automation that has not run for this root event", () => {
    assert.equal(checkAncestry(A, new Set()).allowed, true);
    assert.equal(checkAncestry(A, new Set([B])).allowed, true);
  });

  it("stops an automation that has already run in this lineage", () => {
    const verdict = checkAncestry(A, new Set([A]));
    assert.equal(verdict.allowed, false);
    assert.ok(!verdict.allowed && verdict.reason.length > 0);
  });

  it("catches a two-automation cycle on its second pass, not its tenth", () => {
    // A -> B -> A. By the time the event comes back around to A, A is
    // already in the ancestry, so it is refused immediately — rather
    // than looping until the action budget happens to run out.
    const ancestry = new Set<string>();
    assert.equal(checkAncestry(A, ancestry).allowed, true);
    ancestry.add(A);
    assert.equal(checkAncestry(B, ancestry).allowed, true);
    ancestry.add(B);
    assert.equal(checkAncestry(A, ancestry).allowed, false);
  });

  it("catches a self-cycle immediately", () => {
    const ancestry = new Set<string>();
    assert.equal(checkAncestry(A, ancestry).allowed, true);
    ancestry.add(A);
    assert.equal(checkAncestry(A, ancestry).allowed, false);
  });
});
