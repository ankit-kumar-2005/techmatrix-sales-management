"use client";

import { MAX_DECISION_OUTCOMES } from "../config/safeguards";
import type { DecisionOutcome } from "../registry/definitions";
import { ConditionGroupEditor } from "./condition-group-editor";

type DecisionOutcomesEditorProps = {
  outcomes: DecisionOutcome[];
  onChange: (next: DecisionOutcome[]) => void;
  disabled: boolean;
};

function newOutcome(existing: DecisionOutcome[]): DecisionOutcome {
  // A short, node-local id — only ever compared against edges leaving
  // THIS node, so it does not need to be globally unique, only unique
  // within this outcome list (checked by decisionConfigSchema).
  const id = `outcome-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    name: `Outcome ${existing.length + 1}`,
    root: { kind: "group", match: "all", rules: [{ kind: "rule", field: "source", operator: "equals", value: null, valueTo: null }] },
  };
}

/**
 * THE DECISION NODE'S OUTCOME LIST — named, ordered branches, each with
 * its own AND/OR condition tree (the exact same ConditionGroupEditor a
 * plain condition node already uses, just one instance per outcome).
 *
 * Order matters and is shown as such: outcomes are evaluated top to
 * bottom and the first match wins, which is why this is a numbered list
 * with move-up/move-down controls rather than a free-floating set of
 * cards. The "Otherwise" row at the end is not part of `outcomes` at
 * all — it is drawn here as a fixed, unremovable reminder that a
 * decision always has a default path, matching DECISION_DEFAULT_BRANCH
 * in the registry and how the canvas node renders its handles.
 */
export function DecisionOutcomesEditor({ outcomes, onChange, disabled }: DecisionOutcomesEditorProps) {
  const canAdd = outcomes.length < MAX_DECISION_OUTCOMES;

  function update(index: number, next: DecisionOutcome) {
    const copy = [...outcomes];
    copy[index] = next;
    onChange(copy);
  }

  function remove(index: number) {
    onChange(outcomes.filter((_, i) => i !== index));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= outcomes.length) return;
    const copy = [...outcomes];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    onChange(copy);
  }

  return (
    <div className="flex flex-col gap-3">
      {outcomes.map((outcome, index) => (
        <div key={outcome.id} className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-amber-800">
              {index + 1}
            </span>
            <input
              type="text"
              value={outcome.name}
              disabled={disabled}
              onChange={(event) => update(index, { ...outcome, name: event.target.value })}
              placeholder="Outcome name"
              className="h-8 flex-1 rounded-lg border border-neutral-300 bg-white px-2 text-xs font-semibold text-neutral-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            />
            {!disabled ? (
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label="Move outcome up"
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronIcon direction="up" />
                </button>
                <button
                  type="button"
                  disabled={index === outcomes.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move outcome down"
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronIcon direction="down" />
                </button>
                <button
                  type="button"
                  disabled={outcomes.length <= 1}
                  onClick={() => remove(index)}
                  aria-label="Remove outcome"
                  title={outcomes.length <= 1 ? "A decision needs at least one outcome." : "Remove this outcome"}
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <RemoveIcon />
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-2">
            <ConditionGroupEditor group={outcome.root} onChange={(next) => update(index, { ...outcome, root: next })} disabled={disabled} depth={1} />
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[10px] font-bold text-neutral-600">
          &infin;
        </span>
        <span>
          <strong className="font-semibold text-neutral-700">Otherwise</strong> — always present. Any lead that
          matches none of the outcomes above takes this path.
        </span>
      </div>

      {!disabled ? (
        <button
          type="button"
          disabled={!canAdd}
          onClick={() => onChange([...outcomes, newOutcome(outcomes)])}
          title={!canAdd ? `A decision can have at most ${MAX_DECISION_OUTCOMES} outcomes.` : undefined}
          className="self-start rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-neutral-600 hover:border-sky-400 hover:text-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Add outcome
        </button>
      ) : null}
    </div>
  );
}

function ChevronIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth={2}>
      <path d={direction === "up" ? "M5 12.5l5-5 5 5" : "M5 7.5l5 5 5-5"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth={2}>
      <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
    </svg>
  );
}
