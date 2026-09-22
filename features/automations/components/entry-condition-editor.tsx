"use client";

import { DEFAULT_CONDITION_GROUP_CONFIG } from "../registry/condition-group";
import { ConditionGroupEditor } from "./condition-group-editor";
import type { ConditionGroup } from "../registry/condition-group";

type EntryConditionEditorProps = {
  value: ConditionGroup | null;
  onChange: (next: ConditionGroup | null) => void;
  disabled: boolean;
};

/**
 * "Only run when…" — a plain filter on the Start node itself, so a
 * simple rule doesn't need a whole separate Condition node right after
 * the trigger. `null` means off (runs for anything the event/source
 * above already matched); ON reuses the exact same field registry and
 * AND/OR evaluator `lead.match` already runs — there is still only one
 * AND/OR engine in this app. Deliberately FLAT (`allowGroups={false}`):
 * one AND or one OR across the whole list, no nesting, matching what an
 * entry filter actually needs — a Condition node downstream still has
 * the full nested version for anything more elaborate.
 */
export function EntryConditionEditor({ value, onChange, disabled }: EntryConditionEditorProps) {
  const enabled = value !== null;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-xs font-semibold text-neutral-700">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? DEFAULT_CONDITION_GROUP_CONFIG.root : null)}
          className="h-3.5 w-3.5 rounded border-neutral-300 text-sky-600 focus:ring-sky-500/40"
        />
        Only run when…
      </label>

      {enabled ? (
        <ConditionGroupEditor group={value} onChange={onChange} disabled={disabled} depth={1} allowGroups={false} />
      ) : (
        <p className="text-[11px] leading-relaxed text-neutral-400">
          Runs for every lead the event above matches. Turn this on to narrow it further — for example, only when
          deal value is over a certain amount.
        </p>
      )}
    </div>
  );
}
