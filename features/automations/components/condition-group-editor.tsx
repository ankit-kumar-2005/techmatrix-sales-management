"use client";

import { MAX_CONDITION_GROUP_DEPTH, MAX_CONDITION_GROUP_RULES } from "../config/safeguards";
import { LEAD_FIELD_REGISTRY, OPERATORS_BY_TYPE, OPERATOR_LABELS, type FieldOperator, type FieldRegistryEntry } from "../registry/fields";
import type { ConditionGroup, ConditionRule } from "../registry/condition-group";

type ConditionGroupEditorProps = {
  group: ConditionGroup;
  onChange: (next: ConditionGroup) => void;
  disabled: boolean;
  /** 1 for the root group, incrementing with each nested group — the
   *  same number MAX_CONDITION_GROUP_DEPTH bounds server-side, so "Add
   *  group" simply disables itself once the UI can no longer produce
   *  anything the server would accept. */
  depth: number;
  /** False for a context that only accepts one flat AND/OR list, no
   *  nested groups — a trigger's own entry condition, unlike a
   *  standalone Condition node's `lead.match`. Hides "+ Add group"
   *  rather than disabling it, since it is not a limit being approached,
   *  it is a shape this context never offers at all. Purely a UI
   *  convenience — the real enforcement is the schema's own flatness
   *  check (see leadCreatedConfigSchema's entryCondition refinement). */
  allowGroups?: boolean;
  /** Defaults to LEAD_FIELD_REGISTRY — every existing caller (Decision,
   *  lead.match, a trigger's entry condition) reads Lead facts only, and
   *  omitting this prop keeps that exactly unchanged. Get Records is the
   *  one caller that passes TASK_FIELD_REGISTRY/CONTACT_FIELD_REGISTRY
   *  instead, since its own filter runs against whichever object the
   *  admin picked, not always Lead. */
  fieldRegistry?: ReadonlyArray<FieldRegistryEntry>;
};

function operatorsFor(fieldKey: string, fieldRegistry: ReadonlyArray<FieldRegistryEntry>): ReadonlyArray<FieldOperator> {
  const field = fieldRegistry.find((entry) => entry.key === fieldKey);
  return OPERATORS_BY_TYPE[field?.type ?? "text"];
}

function newRule(fieldRegistry: ReadonlyArray<FieldRegistryEntry>): ConditionRule {
  const firstField = fieldRegistry[0];
  return { kind: "rule", field: firstField.key, operator: operatorsFor(firstField.key, fieldRegistry)[0], value: null, valueTo: null };
}

function newGroup(fieldRegistry: ReadonlyArray<FieldRegistryEntry>): ConditionGroup {
  return { kind: "group", match: "all", rules: [newRule(fieldRegistry)] };
}

/**
 * THE AND/OR CONDITION BUILDER — an original Techmatrix control, not a
 * copy of any reference screenshot's layout. It reads its entire menu of
 * fields and operators from the registry (features/automations/registry
 * /fields.ts): there is no field name or operator list written directly
 * in this file, so a field added to the registry appears here for free
 * and a field never here cannot be typed in by a user either — there is
 * no free-text field-name input anywhere in this component.
 *
 * RECURSIVE, MATCHING THE RECURSIVE SHAPE IT EDITS. A nested group
 * renders as another ConditionGroupEditor, one level indented, with its
 * own Match selector — this is what makes `(A AND B) OR (C AND D)`
 * buildable: the outer group's match is "any", each of its two rules is
 * itself a group whose match is "all".
 */
export function ConditionGroupEditor({
  group,
  onChange,
  disabled,
  depth,
  allowGroups = true,
  fieldRegistry = LEAD_FIELD_REGISTRY,
}: ConditionGroupEditorProps) {
  const canAddGroup = allowGroups && depth < MAX_CONDITION_GROUP_DEPTH;
  const canAddRule = group.rules.length < MAX_CONDITION_GROUP_RULES;

  function updateRule(index: number, next: ConditionRule | ConditionGroup) {
    const rules = [...group.rules];
    rules[index] = next;
    onChange({ ...group, rules });
  }

  function removeRule(index: number) {
    onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) });
  }

  return (
    <div className={depth > 1 ? "rounded-lg border border-neutral-200 bg-neutral-50/60 p-3" : ""}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-neutral-700">Match</span>
        <select
          value={group.match}
          disabled={disabled}
          onChange={(event) => onChange({ ...group, match: event.target.value as "all" | "any" })}
          className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs font-semibold text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="all">ALL of the following (AND)</option>
          <option value="any">ANY of the following (OR)</option>
        </select>
      </div>

      <div className="mt-2 flex flex-col gap-2">
        {group.rules.map((child, index) =>
          child.kind === "group" ? (
            <div key={index} className="flex items-start gap-2">
              <div className="flex-1">
                <ConditionGroupEditor
                  group={child}
                  onChange={(next) => updateRule(index, next)}
                  disabled={disabled}
                  depth={depth + 1}
                  allowGroups={allowGroups}
                  fieldRegistry={fieldRegistry}
                />
              </div>
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => removeRule(index)}
                  aria-label="Remove this group"
                  className="mt-1 shrink-0 rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-500/40 focus-visible:outline-none"
                >
                  <RemoveIcon />
                </button>
              ) : null}
            </div>
          ) : (
            <RuleRow
              key={index}
              rule={child}
              onChange={(next) => updateRule(index, next)}
              onRemove={() => removeRule(index)}
              disabled={disabled}
              fieldRegistry={fieldRegistry}
            />
          ),
        )}
      </div>

      {!disabled ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canAddRule}
            onClick={() => onChange({ ...group, rules: [...group.rules, newRule(fieldRegistry)] })}
            className="rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-neutral-600 hover:border-sky-400 hover:text-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            + Add condition
          </button>
          {allowGroups ? (
            <button
              type="button"
              disabled={!canAddGroup || !canAddRule}
              title={!canAddGroup ? `Groups can only nest ${MAX_CONDITION_GROUP_DEPTH} levels deep.` : undefined}
              onClick={() => onChange({ ...group, rules: [...group.rules, newGroup(fieldRegistry)] })}
              className="rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-neutral-600 hover:border-sky-400 hover:text-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              + Add group
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RuleRow({
  rule,
  onChange,
  onRemove,
  disabled,
  fieldRegistry,
}: {
  rule: ConditionRule;
  onChange: (next: ConditionRule) => void;
  onRemove: () => void;
  disabled: boolean;
  fieldRegistry: ReadonlyArray<FieldRegistryEntry>;
}) {
  const field = fieldRegistry.find((entry) => entry.key === rule.field);
  const operators = operatorsFor(rule.field, fieldRegistry);
  const needsValue = !["is_empty", "is_not_empty", "is_true", "is_false"].includes(rule.operator);
  const needsTwoValues = rule.operator === "between";
  const needsMultiValue = rule.operator === "is_any_of";

  return (
    <div className="flex flex-wrap items-start gap-1.5 rounded-lg bg-white p-2 ring-1 ring-neutral-100">
      <select
        value={rule.field}
        disabled={disabled}
        onChange={(event) => {
          const nextField = event.target.value;
          const nextOperators = operatorsFor(nextField, fieldRegistry);
          onChange({ ...rule, field: nextField, operator: nextOperators[0], value: null, valueTo: null });
        }}
        className="h-8 min-w-[9rem] rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {fieldRegistry.map((entry) => (
          <option key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </select>

      <select
        value={rule.operator}
        disabled={disabled}
        onChange={(event) => onChange({ ...rule, operator: event.target.value as FieldOperator, value: null, valueTo: null })}
        className="h-8 min-w-[7rem] rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {operators.map((operator) => (
          <option key={operator} value={operator}>
            {OPERATOR_LABELS[operator]}
          </option>
        ))}
      </select>

      {needsMultiValue && field?.enumOptions ? (
        <div className="flex flex-wrap gap-1">
          {field.enumOptions.map((option) => {
            const selected = Array.isArray(rule.value) ? (rule.value as string[]) : [];
            const checked = selected.includes(option.value);
            return (
              <label
                key={option.value}
                className={`cursor-pointer rounded-full border px-2 py-1 text-[11px] font-medium transition-colors ${
                  checked ? "border-sky-400 bg-sky-50 text-sky-700" : "border-neutral-300 text-neutral-600"
                }`}
              >
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={checked}
                  onChange={(event) =>
                    onChange({
                      ...rule,
                      value: event.target.checked ? [...selected, option.value] : selected.filter((v) => v !== option.value),
                    })
                  }
                  className="sr-only"
                />
                {option.label}
              </label>
            );
          })}
        </div>
      ) : null}

      {needsValue && !needsMultiValue && field?.type === "enum" && field.enumOptions ? (
        <select
          value={typeof rule.value === "string" ? rule.value : ""}
          disabled={disabled}
          onChange={(event) => onChange({ ...rule, value: event.target.value })}
          className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">Choose...</option>
          {field.enumOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}

      {needsValue && !needsMultiValue && field?.type !== "enum" ? (
        <>
          <input
            type={field?.type === "number" ? "number" : field?.type === "date" ? "date" : "text"}
            disabled={disabled}
            value={typeof rule.value === "string" || typeof rule.value === "number" ? String(rule.value) : ""}
            onChange={(event) =>
              onChange({ ...rule, value: field?.type === "number" ? Number(event.target.value) : event.target.value })
            }
            placeholder={needsTwoValues ? "From" : "Value"}
            className="h-8 w-28 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {needsTwoValues ? (
            <input
              type={field?.type === "date" ? "date" : "text"}
              disabled={disabled}
              value={typeof rule.valueTo === "string" || typeof rule.valueTo === "number" ? String(rule.valueTo) : ""}
              onChange={(event) => onChange({ ...rule, valueTo: event.target.value })}
              placeholder="To"
              className="h-8 w-28 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            />
          ) : null}
        </>
      ) : null}

      {!disabled ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove this condition"
          className="ml-auto shrink-0 rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-500/40 focus-visible:outline-none"
        >
          <RemoveIcon />
        </button>
      ) : null}
    </div>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth={2}>
      <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
    </svg>
  );
}
