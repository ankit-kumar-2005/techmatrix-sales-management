"use client";

import { MAX_ASSIGNMENTS_PER_NODE } from "../config/safeguards";
import { LEAD_FIELD_REGISTRY } from "../registry/fields";
import type { AssignmentEntry, AssignmentOperator, AssignmentValueSource } from "../registry/definitions";
import { FieldReferencePicker } from "./field-reference-picker";

type AssignmentEditorProps = {
  assignments: AssignmentEntry[];
  onChange: (next: AssignmentEntry[]) => void;
  disabled: boolean;
};

const OPERATOR_OPTIONS: ReadonlyArray<{ value: AssignmentOperator; label: string }> = [
  { value: "set", label: "Set to" },
  { value: "add", label: "Add (numbers)" },
  { value: "subtract", label: "Subtract (numbers)" },
  { value: "append", label: "Append text" },
];

function newAssignment(): AssignmentEntry {
  return { variable: "", operator: "set", valueSource: "field", staticValue: "", fieldKey: LEAD_FIELD_REGISTRY[0].key };
}

/**
 * THE ASSIGNMENT NODE'S VARIABLE LIST.
 *
 * Each row computes ONE named value — from a lead field or typed text —
 * that later steps in the same run can reuse by writing {{var.name}} in
 * a task subject/description or the Update Lead action's "Next step".
 * That reuse mechanism (plan-workflow.ts) is a closed, fixed-pattern
 * string substitution, the same shape {{lead.company}} already uses —
 * this editor cannot produce anything else, because there is nowhere
 * here to type an expression, only a variable name, an operator and a
 * source.
 */
export function AssignmentEditor({ assignments, onChange, disabled }: AssignmentEditorProps) {
  const canAdd = assignments.length < MAX_ASSIGNMENTS_PER_NODE;

  function update(index: number, next: AssignmentEntry) {
    const copy = [...assignments];
    copy[index] = next;
    onChange(copy);
  }

  function remove(index: number) {
    onChange(assignments.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-2">
      {assignments.map((assignment, index) => (
        <div key={index} className="flex flex-col gap-1.5 rounded-lg bg-white p-2.5 ring-1 ring-neutral-100">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-neutral-500">Set</span>
            <input
              type="text"
              value={assignment.variable}
              disabled={disabled}
              onChange={(event) => update(index, { ...assignment, variable: event.target.value })}
              placeholder="variable_name"
              className="h-8 w-32 rounded-lg border border-neutral-300 bg-white px-2 font-mono text-xs text-neutral-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            />

            <select
              value={assignment.operator}
              disabled={disabled}
              onChange={(event) => update(index, { ...assignment, operator: event.target.value as AssignmentOperator })}
              className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {OPERATOR_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              value={assignment.valueSource}
              disabled={disabled}
              onChange={(event) => update(index, { ...assignment, valueSource: event.target.value as AssignmentValueSource })}
              className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="field">a lead field</option>
              <option value="static">typed text</option>
            </select>

            {assignment.valueSource === "field" ? (
              <select
                value={assignment.fieldKey}
                disabled={disabled}
                onChange={(event) => update(index, { ...assignment, fieldKey: event.target.value })}
                className="h-8 min-w-[9rem] rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {LEAD_FIELD_REGISTRY.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  type="text"
                  value={assignment.staticValue}
                  disabled={disabled}
                  onChange={(event) => update(index, { ...assignment, staticValue: event.target.value })}
                  placeholder="Value"
                  className="h-8 w-32 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <FieldReferencePicker
                  value={assignment.staticValue}
                  onInsert={(next) => update(index, { ...assignment, staticValue: next })}
                  disabled={disabled}
                />
              </>
            )}

            {!disabled ? (
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label="Remove this assignment"
                className="ml-auto shrink-0 rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-500/40 focus-visible:outline-none"
              >
                <RemoveIcon />
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-neutral-400">
            Reuse this later as <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono">{`{{var.${assignment.variable || "name"}}}`}</code>
          </p>
        </div>
      ))}

      {!disabled ? (
        <button
          type="button"
          disabled={!canAdd}
          onClick={() => onChange([...assignments, newAssignment()])}
          title={!canAdd ? `An assignment node can set at most ${MAX_ASSIGNMENTS_PER_NODE} variables.` : undefined}
          className="self-start rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-neutral-600 hover:border-sky-400 hover:text-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Add assignment
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
