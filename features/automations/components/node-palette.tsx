"use client";

import { getEntriesByKind, getRegistryEntry } from "../registry/definitions";
import { PALETTE_CATALOG, type PaletteCategory } from "../registry/palette-catalog";
import type { AutomationNodeKind } from "@/types/automation";

type NodePaletteProps = {
  onAdd: (kind: AutomationNodeKind, type: string) => void;
  /** True once a trigger is on the canvas — a workflow may only have
   *  one, so the rest are disabled rather than silently rejected after
   *  the click. */
  hasTrigger: boolean;
  disabled: boolean;
};

const CATALOG_SECTIONS: Array<{ category: PaletteCategory }> = [{ category: "logic" }, { category: "records" }];

/**
 * The palette — Start, then a Salesforce-style Logic/Data split, per
 * PALETTE_CATALOG (see that file for why Logic/Data is a curated
 * allowlist rather than "every registered entry of this kind", unlike
 * Start below). Adding a node here does not wire it to anything — that
 * is what the contextual "+" chips on the canvas are for (see
 * node-insert-menu.tsx, which reads the identical catalog); this
 * palette is for a plain, unconnected add, which is the only way to
 * place the one trigger a workflow starts with.
 */
export function NodePalette({ onAdd, hasTrigger, disabled }: NodePaletteProps) {
  const triggers = getEntriesByKind("trigger");

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-3">
      <section>
        <h3 className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">Start</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-400">
          What starts the workflow. Pick exactly one.
        </p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {triggers.map((entry) => {
            const blocked = disabled || hasTrigger;
            return (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={() => onAdd(entry.kind, entry.key)}
                  disabled={blocked}
                  title={blocked ? "A workflow can only have one trigger." : entry.description}
                  className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-2 text-left transition-colors hover:border-sky-400 hover:bg-sky-50/50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-200 disabled:hover:bg-white"
                >
                  <span className="block text-xs font-semibold text-neutral-800">{entry.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">{entry.description}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {CATALOG_SECTIONS.map(({ category }) => {
        const section = PALETTE_CATALOG[category];
        return (
          <section key={category}>
            <h3 className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">{section.title}</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-400">{section.blurb}</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {section.items.map((item) => {
                if (item.status === "soon") {
                  return (
                    <li key={item.label} title={item.description}>
                      <div className="w-full cursor-not-allowed rounded-lg border border-dashed border-neutral-200 px-2.5 py-2 opacity-60">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-neutral-500">
                          {item.label}
                          <span className="rounded bg-neutral-100 px-1 py-0.5 text-[9px] font-bold tracking-wide text-neutral-400 uppercase">
                            Soon
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">{item.description}</span>
                      </div>
                    </li>
                  );
                }

                const entry = getRegistryEntry(item.key);
                if (!entry) return null;

                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      onClick={() => onAdd(entry.kind, entry.key)}
                      disabled={disabled}
                      title={entry.description}
                      className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-2 text-left transition-colors hover:border-sky-400 hover:bg-sky-50/50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-200 disabled:hover:bg-white"
                    >
                      <span className="block text-xs font-semibold text-neutral-800">{entry.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">{entry.description}</span>
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
