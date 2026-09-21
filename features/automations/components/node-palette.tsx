"use client";

import { getEntriesByKind } from "../registry/definitions";
import type { AutomationNodeKind } from "@/types/automation";

type NodePaletteProps = {
  onAdd: (kind: AutomationNodeKind, type: string) => void;
  /** True once a trigger is on the canvas — a workflow may only have
   *  one, so the rest are disabled rather than silently rejected after
   *  the click. */
  hasTrigger: boolean;
  disabled: boolean;
};

const SECTIONS: Array<{ kind: AutomationNodeKind; title: string; blurb: string }> = [
  { kind: "trigger", title: "When this happens", blurb: "What starts the workflow. Pick exactly one." },
  { kind: "condition", title: "Only if", blurb: "Splits the workflow into a yes path and a no path." },
  { kind: "action", title: "Then do this", blurb: "What actually happens. This is the part that writes data." },
];

/**
 * The palette — EVERYTHING this app can do, read from the registry.
 *
 * There is no hardcoded list here. An action added to
 * registry/definitions.ts appears in this palette, in the AI's prompt,
 * in validation and in the engine at the same moment, because all four
 * read the same file.
 */
export function NodePalette({ onAdd, hasTrigger, disabled }: NodePaletteProps) {
  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-3">
      {SECTIONS.map((section) => {
        const entries = getEntriesByKind(section.kind);
        return (
          <section key={section.kind}>
            <h3 className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">{section.title}</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-400">{section.blurb}</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {entries.map((entry) => {
                const blocked = disabled || (section.kind === "trigger" && hasTrigger);
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      onClick={() => onAdd(section.kind, entry.key)}
                      disabled={blocked}
                      title={blocked && section.kind === "trigger" ? "A workflow can only have one trigger." : entry.description}
                      className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-2 text-left transition-colors hover:border-sky-400 hover:bg-sky-50/50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-200 disabled:hover:bg-white"
                    >
                      <span className="block text-xs font-semibold text-neutral-800">{entry.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">
                        {entry.description}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
