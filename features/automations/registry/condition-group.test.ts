import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CONDITION_GROUP_DEPTH, MAX_CONDITION_GROUP_RULES } from "../config/safeguards";
import { conditionFieldGroupConfigSchema, DEFAULT_CONDITION_GROUP_CONFIG, type ConditionGroup } from "./condition-group";

/**
 * THE GENERIC CONDITION'S SCHEMA — field/operator cross-checks and the
 * depth limit, which Zod's own recursive type cannot express on its own
 * (see condition-group.ts's own note on why the walk is manual).
 */

function group(match: "all" | "any", rules: ConditionGroup["rules"]): ConditionGroup {
  return { kind: "group", match, rules };
}
function rule(field: string, operator: string, value: unknown = null, valueTo: unknown = null) {
  return { kind: "rule" as const, field, operator: operator as never, value: value as never, valueTo: valueTo as never };
}

describe("conditionFieldGroupConfigSchema — the happy path", () => {
  it("accepts a single rule", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("source", "equals", "IndiaMART")]),
    });
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  it("accepts AND across several rules", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("deal_value", "greater_than", 50000), rule("source", "equals", "IndiaMART")]),
    });
    assert.equal(result.success, true);
  });

  it("accepts a nested group — (A AND B) OR C", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("any", [
        group("all", [rule("source", "equals", "IndiaMART"), rule("deal_value", "greater_than", 50000)]),
        rule("status", "equals", "Active"),
      ]),
    });
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  it("accepts every no-value operator with value: null", () => {
    for (const operator of ["is_empty", "is_not_empty"]) {
      const result = conditionFieldGroupConfigSchema.safeParse({
        root: group("all", [rule("next_step", operator)]),
      });
      assert.equal(result.success, true, `${operator}: ${JSON.stringify(!result.success && result.error.issues)}`);
    }
  });

  it("accepts is_any_of with a non-empty array", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("source", "is_any_of", ["IndiaMART", "Manual"])]),
    });
    assert.equal(result.success, true);
  });

  it("accepts between with both bounds", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("expected_close_date", "between", "2026-01-01", "2026-12-31")]),
    });
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  it("the shipped default is valid EXCEPT for the one deliberately-incomplete rule", () => {
    // Same "default is incomplete on purpose" convention task.create's
    // own default already established — this default should fail on
    // nothing except the missing value.
    const result = conditionFieldGroupConfigSchema.safeParse(DEFAULT_CONDITION_GROUP_CONFIG);
    assert.equal(result.success, false);
    assert.ok(!result.success && result.error.issues.every((issue) => issue.path.at(-1) === "value"));
  });
});

describe("conditionFieldGroupConfigSchema — the registry is the menu", () => {
  it("rejects an unregistered field", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("ssn", "equals", "123")]),
    });
    assert.equal(result.success, false);
  });

  it("rejects an operator invalid for the field's type", () => {
    // "contains" is a text operator; source is an enum field.
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("source", "contains", "India")]),
    });
    assert.equal(result.success, false);
  });

  it("rejects greater_than on a text field", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("company", "greater_than", "5")]),
    });
    assert.equal(result.success, false);
  });

  it("rejects is_any_of with an empty array", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("source", "is_any_of", [])]),
    });
    assert.equal(result.success, false);
  });

  it("rejects between with only one bound", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("expected_close_date", "between", "2026-01-01", null)]),
    });
    assert.equal(result.success, false);
  });

  it("rejects a comparison operator with no value", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({
      root: group("all", [rule("deal_value", "greater_than", null)]),
    });
    assert.equal(result.success, false);
  });

  it("rejects an empty group", () => {
    const result = conditionFieldGroupConfigSchema.safeParse({ root: group("all", []) });
    assert.equal(result.success, false);
  });
});

describe("conditionFieldGroupConfigSchema — the depth and width limits", () => {
  it("accepts a tree exactly at the depth limit", () => {
    let innermost: ConditionGroup = group("all", [rule("source", "equals", "IndiaMART")]);
    for (let level = 1; level < MAX_CONDITION_GROUP_DEPTH; level += 1) {
      innermost = group("all", [innermost]);
    }
    const result = conditionFieldGroupConfigSchema.safeParse({ root: innermost });
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  it("rejects a tree one level past the depth limit", () => {
    let tree: ConditionGroup = group("all", [rule("source", "equals", "IndiaMART")]);
    for (let level = 1; level <= MAX_CONDITION_GROUP_DEPTH; level += 1) {
      tree = group("all", [tree]);
    }
    const result = conditionFieldGroupConfigSchema.safeParse({ root: tree });
    assert.equal(result.success, false);
  });

  it("rejects more rules than the width limit in one group", () => {
    const rules = Array.from({ length: MAX_CONDITION_GROUP_RULES + 1 }, () => rule("source", "equals", "IndiaMART"));
    const result = conditionFieldGroupConfigSchema.safeParse({ root: group("all", rules) });
    assert.equal(result.success, false);
  });

  it("accepts exactly the width limit", () => {
    const rules = Array.from({ length: MAX_CONDITION_GROUP_RULES }, () => rule("source", "equals", "IndiaMART"));
    const result = conditionFieldGroupConfigSchema.safeParse({ root: group("all", rules) });
    assert.equal(result.success, true);
  });
});

describe("conditionFieldGroupConfigSchema — malformed input never throws", () => {
  for (const [label, value] of [
    ["null", null],
    ["a string", "not a condition"],
    ["an empty object", {}],
    ["root as a rule, not a group", { root: rule("source", "equals", "IndiaMART") }],
    ["rules as a string", { root: { kind: "group", match: "all", rules: "x" } }],
  ] as const) {
    it(`refuses ${label} without throwing`, () => {
      const result = conditionFieldGroupConfigSchema.safeParse(value);
      assert.equal(result.success, false);
    });
  }
});
