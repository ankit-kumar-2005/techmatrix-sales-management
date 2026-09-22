"use client";

import { useId, useState } from "react";
import { ChevronDownIcon, GlobeIcon } from "@/features/sales-management/components/icons";
import type { ComingSoonSourceMetadata } from "../lib/providers/coming-soon-sources";

type ComingSoonSourceCardProps = {
  source: ComingSoonSourceMetadata;
};

/**
 * A "Soon" sibling to SourceCard — deliberately NOT SourceCard itself.
 * SourceCard's not-connected footer copy ("Connect this source to
 * start capturing leads.") is a real affordance this card must never
 * make, since there is nothing to connect. Same badge treatment as the
 * real card (one plain letter/icon mark in the app's existing
 * gradient, no separate "muted" badge style) — the "not real yet"
 * signal comes from the dashed border and the "Soon" chip, the same
 * disabled-entry pattern the Automations builder's node palette
 * already established, not from degrading the mark itself.
 *
 * CLICKING REVEALS ONE OR TWO SENTENCES, NOTHING SHAPED LIKE A
 * CONNECTION PANEL. An earlier pass here built a fuller "preview" of
 * IndiaMART's real Connection panel (a URL field, numbered setup
 * steps) — deliberately replaced with this instead, because ANY
 * version of that layout, however clearly labeled, risks being
 * skimmed as something functional. This card owns one boolean and
 * shows two lines of plain text: what the source will do, and that
 * it's coming soon.
 *
 * The expand/collapse mechanics (button + aria-expanded/aria-controls
 * + rotating chevron + conditionally-mounted body) mirror
 * MeetingNoteCardShell — the one existing "click to reveal a bit more
 * inline" idiom already in this codebase — rather than inventing a new
 * one; there was no shared Tooltip/Disclosure component to import.
 */
export function ComingSoonSourceCard({ source }: ComingSoonSourceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const noteId = useId();

  return (
    <div
      className={`flex h-full flex-col rounded-2xl border border-dashed p-5 transition-colors duration-200 ${
        expanded ? "border-sky-300 bg-sky-50/40" : "border-neutral-200 bg-white"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={noteId}
        className="flex w-full items-start gap-3 text-left"
      >
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-xs font-bold text-white shadow-sm"
        >
          {source.useGlobeIcon ? <GlobeIcon className="h-5 w-5" /> : source.initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-neutral-900">{source.displayName}</span>
            <span className="inline-flex shrink-0 items-center rounded-full bg-neutral-100 px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-neutral-500 uppercase ring-1 ring-inset ring-neutral-200">
              Soon
            </span>
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-neutral-500">{source.description}</span>
        </span>
        <span className="sr-only">{expanded ? `Collapse ${source.displayName} details` : `More about ${source.displayName}`}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={`mt-0.5 h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded ? (
        <p id={noteId} className="mt-3 border-t border-neutral-100 pt-3 text-xs leading-relaxed text-neutral-500">
          {source.expandedNote}
        </p>
      ) : null}
    </div>
  );
}
