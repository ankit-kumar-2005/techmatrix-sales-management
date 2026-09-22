"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getRegistryEntry } from "../registry/definitions";
import { PALETTE_CATALOG } from "../registry/palette-catalog";
import type { AutomationNodeKind } from "@/types/automation";

type NodeInsertMenuProps = {
  anchor: { x: number; y: number };
  onPick: (kind: AutomationNodeKind, type: string) => void;
  onClose: () => void;
};

/**
 * THE CONTEXTUAL "+" MENU — what opens when an admin clicks a "+" chip
 * on a dangling output or the "+" on an edge's midpoint.
 *
 * Reads the exact same PALETTE_CATALOG the sidebar palette does — there
 * is no second, narrower list of "things you can insert here" to keep
 * in sync with "things the palette offers". Triggers are never offered
 * here (the catalog itself has none): this menu only ever appends AFTER
 * an existing node, and a workflow can have only one trigger, which the
 * canvas always starts with.
 */
export function NodeInsertMenu({ anchor, onPick, onClose }: NodeInsertMenuProps) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onDocClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const filteredSections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (Object.keys(PALETTE_CATALOG) as Array<keyof typeof PALETTE_CATALOG>)
      .map((category) => {
        const section = PALETTE_CATALOG[category];
        const real = section.items
          .filter((item) => item.status === "real")
          .map((item) => getRegistryEntry(item.key))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
          .filter((entry) => !needle || entry.label.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle));
        const soon = section.items
          .filter((item) => item.status === "soon")
          .filter((item) => !needle || item.label.toLowerCase().includes(needle));
        return { title: section.title, real, soon };
      })
      .filter((section) => section.real.length > 0 || section.soon.length > 0);
  }, [query]);

  // Clamped so the menu cannot render off the right/bottom edge of the
  // viewport when a node near the canvas boundary opens it.
  const left = Math.min(anchor.x + 10, typeof window !== "undefined" ? window.innerWidth - 300 : anchor.x);
  const top = Math.min(anchor.y - 20, typeof window !== "undefined" ? window.innerHeight - 360 : anchor.y);

  // PORTALED TO document.body, DELIBERATELY. `position: fixed` computes
  // against the viewport ONLY when no ancestor sets a `transform` (or
  // `filter`/`perspective`/`will-change: transform`) — and it establishes
  // a NEW containing block for `fixed` descendants when one does. This
  // menu's `anchor` is always screen coordinates (clientX/clientY from
  // the click, or a button's own getBoundingClientRect()), so it must
  // actually be positioned against the real viewport, not against
  // whatever ancestor happens to have a transform applied somewhere
  // between here and <body> — which is exactly the bug a plain in-tree
  // render hit: the menu was opening, just not where anyone could see or
  // click it.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Add a step"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      className="fixed z-[999] flex max-h-[360px] w-72 flex-col overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-black/10"
    >
      <div className="border-b border-neutral-100 p-2.5">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search steps..."
          className="h-8 w-full rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 text-xs text-neutral-800 outline-none focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {filteredSections.length === 0 ? (
          <p className="p-3 text-center text-xs text-neutral-400">Nothing matches &ldquo;{query}&rdquo;.</p>
        ) : (
          filteredSections.map((section) => (
            <div key={section.title} className="mb-2">
              <p className="px-1.5 py-1 text-[10px] font-bold tracking-wide text-neutral-400 uppercase">{section.title}</p>
              <ul className="flex flex-col gap-1">
                {section.real.map((entry) => (
                  <li key={entry.key}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => onPick(entry.kind, entry.key)}
                      className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sky-50 focus-visible:bg-sky-50 focus-visible:outline-none"
                    >
                      <span className="block text-xs font-semibold text-neutral-800">{entry.label}</span>
                      <span className="mt-0.5 block line-clamp-1 text-[11px] text-neutral-500">{entry.description}</span>
                    </button>
                  </li>
                ))}
                {section.soon.map((item) => (
                  <li key={item.label} title={item.description}>
                    <div className="w-full cursor-not-allowed rounded-lg px-2 py-1.5 text-left opacity-50">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-neutral-500">
                        {item.label}
                        <span className="rounded bg-neutral-100 px-1 py-0.5 text-[9px] font-bold tracking-wide text-neutral-400 uppercase">
                          Soon
                        </span>
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-[11px] text-neutral-400">{item.description}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
