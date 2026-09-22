import { z } from "zod";
import {
  MAX_CONDITION_GROUP_DEPTH,
  MAX_CONDITION_GROUP_RULES,
  MAX_CONDITION_OPERATOR_LENGTH,
  MAX_CONDITION_VALUE_LENGTH,
  MAX_CONDITION_VALUE_LIST_LENGTH,
  MAX_NODE_ID_LENGTH,
} from "../config/safeguards";
import { OPERATORS_BY_TYPE, getFieldDefinition, type FieldOperator } from "./fields";

/**
 * THE GENERIC CONDITION — one config type replacing "one hardcoded
 * condition per comparison this app happens to support" with a real
 * AND/OR tree over the field registry.
 *
 * MODELLED AS CONFIG ON A SINGLE CANVAS NODE, NOT AS SEPARATE CANVAS
 * NODES PER RULE. React Flow's edges already carry exactly one piece of
 * boolean information (which branch — true/false) per condition node;
 * representing nested AND/OR as connected nodes would mean inventing a
 * second branching semantics alongside the existing yes/no one. Putting
 * the tree inside one node's config keeps the canvas's meaning
 * unchanged — a condition node still has exactly two outputs — while
 * the node's OWN decision can now be arbitrarily rich.
 *
 * A RULE NEVER NAMES A COLUMN THE ENGINE TRUSTS BLINDLY. `field` is
 * looked up in the field registry both here (structural validation) and
 * in plan-workflow.ts (evaluation) — an unregistered field key fails
 * both, the same "the registry is the menu" guarantee the rest of this
 * app already relies on. There is no code path from a rule to a SQL
 * identifier or a raw property access on anything but the field
 * registry's own known keys.
 */

export type ConditionRule = {
  kind: "rule";
  field: string;
  operator: FieldOperator;
  /** A single comparison value. An array only for `is_any_of`. */
  value: string | number | boolean | string[] | null;
  /** The second bound for `between` only. */
  valueTo: string | number | null;
};

export type ConditionGroup = {
  kind: "group";
  match: "all" | "any";
  rules: Array<ConditionRule | ConditionGroup>;
};

const ruleShape = z.object({
  kind: z.literal("rule"),
  // Reuses MAX_NODE_ID_LENGTH: the same kind of bound (a sanity cap on
  // an internal identifier string) as every other node/edge id in this
  // feature, not a value with any meaning of its own worth a second
  // constant for.
  field: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  // A string, not a fixed enum: which operators are VALID depends on the
  // field's type, checked in the superRefine walk below against the
  // field registry — a hardcoded enum here would have to be the union of
  // every operator across every type, which would let an operator/field
  // mismatch slip past the type system only to fail later at evaluation.
  operator: z.string().trim().min(1).max(MAX_CONDITION_OPERATOR_LENGTH),
  value: z.union([
    z.string().max(MAX_CONDITION_VALUE_LENGTH),
    z.number(),
    z.boolean(),
    z.array(z.string().max(MAX_CONDITION_VALUE_LENGTH)).max(MAX_CONDITION_VALUE_LIST_LENGTH),
    z.null(),
  ]),
  valueTo: z.union([z.string().max(MAX_CONDITION_VALUE_LENGTH), z.number(), z.null()]).default(null),
});

// z.lazy is what makes this recursive — a group's `rules` array can
// contain more groups. Cast to z.ZodType<ConditionGroup> because Zod
// cannot infer a recursive type through z.lazy on its own.
export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.object({
    kind: z.literal("group"),
    match: z.enum(["all", "any"]),
    rules: z.array(z.union([ruleShape, conditionGroupSchema])).max(MAX_CONDITION_GROUP_RULES),
  }),
) as z.ZodType<ConditionGroup>;

export const CONDITION_FIELD_GROUP = "lead.match";

/**
 * The node's whole config: one root group. Depth, per-field operator
 * validity, and value-shape-per-operator are all checked here in one
 * walk — Zod's own recursive types express the SHAPE but not "at most 3
 * levels deep" or "this operator needs an array", so those are a manual
 * post-parse pass, the same way validateWorkflow's own cycle check is a
 * manual walk rather than something Zod expresses natively.
 */
export const conditionFieldGroupConfigSchema = z.object({ root: conditionGroupSchema }).superRefine((value, ctx) => {
  validateConditionGroupShape(value.root, 1, ["root"], ctx);
});

/**
 * The depth/width/operator/value-shape walk Zod's own recursive type
 * cannot express (see conditionGroupSchema's note). Exported so the
 * Decision node's outcome conditions — the SAME ConditionGroup shape,
 * just one per outcome instead of one per node — can be checked with
 * this exact walk rather than a second copy of it. There is only ever
 * one place that decides whether a condition tree is well-formed.
 */
export function validateConditionGroupShape(
  group: ConditionGroup,
  depth: number,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (depth > MAX_CONDITION_GROUP_DEPTH) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `Groups can only nest ${MAX_CONDITION_GROUP_DEPTH} levels deep. Simplify this group.`,
    });
    return;
  }

  if (group.rules.length === 0) {
    ctx.addIssue({ code: "custom", path, message: "Add at least one condition to this group." });
    return;
  }

  group.rules.forEach((child, index) => {
    const childPath = [...path, "rules", index];
    if (child.kind === "group") {
      validateConditionGroupShape(child, depth + 1, childPath, ctx);
      return;
    }

    const field = getFieldDefinition(child.field);
    if (!field) {
      ctx.addIssue({ code: "custom", path: childPath, message: `"${child.field}" is not a field this app knows.` });
      return;
    }

    const validOperators = OPERATORS_BY_TYPE[field.type];
    if (!validOperators.includes(child.operator as FieldOperator)) {
      ctx.addIssue({
        code: "custom",
        path: [...childPath, "operator"],
        message: `"${child.operator}" cannot be used on ${field.label}, which is a ${field.type} field.`,
      });
      return;
    }

    const operator = child.operator as FieldOperator;

    if (operator === "is_empty" || operator === "is_false" || operator === "is_true" || operator === "is_not_empty") {
      // These read no value at all — nothing further to check.
      return;
    }
    if (operator === "is_any_of") {
      if (!Array.isArray(child.value) || child.value.length === 0) {
        ctx.addIssue({ code: "custom", path: [...childPath, "value"], message: "Pick at least one value." });
      }
      return;
    }
    if (operator === "between") {
      if (child.value === null || child.valueTo === null) {
        ctx.addIssue({ code: "custom", path: [...childPath, "value"], message: "Enter both a start and an end." });
      }
      return;
    }
    if (child.value === null || child.value === "") {
      ctx.addIssue({ code: "custom", path: [...childPath, "value"], message: `Enter a value for ${field.label}.` });
    }
  });
}

/** A safe, valid starting point for a freshly-added node — one empty
 *  rule inviting the first pick, not a value that would need a superRefine
 *  message to explain why it's incomplete. */
export const DEFAULT_CONDITION_GROUP_CONFIG: { root: ConditionGroup } = {
  root: { kind: "group", match: "all", rules: [{ kind: "rule", field: "source", operator: "equals", value: null, valueTo: null }] },
};
