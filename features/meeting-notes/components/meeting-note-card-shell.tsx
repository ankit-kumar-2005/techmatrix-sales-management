"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "@/features/sales-management/components/icons";

type MeetingNoteCardShellProps = {
  /** The collapsed row's content — title, pills, meta line, snippet,
   *  completion chip. Rendered on the SERVER and passed in, so this
   *  client component holds one boolean and nothing else. */
  header: ReactNode;
  /** The expanded content — summary block and checklist. Also
   *  server-rendered. Present in the RSC payload either way, but only
   *  MOUNTED when expanded, so the client components inside it (the
   *  action-item rows) do not hydrate for a collapsed note. */
  body: ReactNode;
  /** True for the newest note on page 1 only. */
  defaultExpanded: boolean;
  /** For the toggle's accessible name, so a screen reader hears which
   *  note is being expanded rather than ten identical "Expand" buttons. */
  title: string;
};

/**
 * The disclosure wrapper: one boolean of client state, and the reason
 * the rest of this feature's list can stay a Server Component.
 *
 * WHY THIS SPLIT RATHER THAN MAKING THE CARD A CLIENT COMPONENT: the
 * card computes completion counts, resolves the fuzzy assignee match
 * (fuse.js) and formats dates — all server work, and fuse.js staying out
 * of the client bundle is verified (0 occurrences in .next/static).
 * Passing the already-rendered header/body in as children keeps all of
 * that on the server while the toggle stays instant and local.
 *
 * NO SERVER ROUND TRIP ON TOGGLE. Both halves are already in the RSC
 * payload when the page loads, so expanding is a pure client state
 * change — no fetch, no navigation, no lost scroll position.
 *
 * The body is conditionally RENDERED rather than hidden with CSS on
 * purpose: `hidden` would keep every collapsed note's action-item rows
 * (client components) mounted and hydrated, which at twenty notes is a
 * lot of hydration for content nobody is looking at.
 */
export function MeetingNoteCardShell({ header, body, defaultExpanded, title }: MeetingNoteCardShellProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const bodyId = useId();

  return (
    <article className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      {/* A real <button>, not a div with onClick: this gets keyboard
          focus, Enter/Space, and an aria-expanded state for free. It
          contains only text and pills — no nested interactive elements,
          which is what makes wrapping the whole row legal. */}
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        className="flex w-full cursor-pointer items-start gap-3 p-6 text-left transition-colors hover:bg-neutral-50/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500/40 focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1">{header}</span>
        <span className="sr-only">{isExpanded ? `Collapse ${title}` : `Expand ${title}`}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={`mt-0.5 h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 ${
            isExpanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {isExpanded ? (
        <div id={bodyId} className="px-6 pb-6">
          {body}
        </div>
      ) : null}
    </article>
  );
}
