"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "@/features/sales-management/components/icons";

type DisclosureProps = {
  /** Always-visible summary shown next to the toggle, whether expanded
   *  or not — a one/two-line reminder of what expanding reveals, not a
   *  repeat of the full content. */
  teaser: ReactNode;
  /** The full content — a Server Component's own output is fine here
   *  (see the note below on why this stays a client component without
   *  forcing its children to become one). Mounted only once expanded. */
  children: ReactNode;
  defaultExpanded?: boolean;
  /** For the toggle's accessible name ("Show more: {title}"), so a
   *  screen reader can tell two disclosures on the same page apart. */
  title: string;
};

/**
 * A generic "teaser + Show more/Show less" disclosure — one boolean of
 * client state wrapping server-rendered content, the same split
 * features/meeting-notes/components/meeting-note-card-shell.tsx already
 * uses for its own expand/collapse (there is no dependency between the
 * two; this is a second, small, shared copy of that idiom rather than
 * a cross-feature import, since MeetingNoteCardShell's own props are
 * meeting-notes-flavoured — header/body — where this one is generic).
 *
 * WHY THE CHILDREN CAN STILL BE A SERVER COMPONENT: `children` is
 * already-rendered RSC output by the time it reaches this "use client"
 * boundary — passing it through as a prop does not force it to
 * hydrate as a client component, it is only MOUNTED conditionally on
 * `isExpanded`. That is what keeps something like GuidelinesPanel
 * (which reads the automation registry directly, server-side) able to
 * sit inside this without becoming client code itself.
 */
export function Disclosure({ teaser, children, defaultExpanded = false, title }: DisclosureProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const bodyId = useId();

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      <div className="flex items-start gap-3 p-5 sm:p-6">
        <div className="min-w-0 flex-1 text-sm leading-relaxed text-neutral-600">{teaser}</div>
        <button
          type="button"
          onClick={() => setIsExpanded((current) => !current)}
          aria-expanded={isExpanded}
          aria-controls={bodyId}
          className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold text-sky-600 transition-colors hover:bg-sky-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
        >
          <span aria-hidden="true">{isExpanded ? "Show less" : "Show more"}</span>
          <span className="sr-only">{isExpanded ? `Show less: ${title}` : `Show more: ${title}`}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className={`h-3.5 w-3.5 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {isExpanded ? (
        <div id={bodyId} className="border-t border-neutral-100 p-5 sm:p-6">
          {children}
        </div>
      ) : null}
    </div>
  );
}
