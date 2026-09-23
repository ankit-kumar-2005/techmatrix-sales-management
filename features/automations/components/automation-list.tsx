import Link from "next/link";
import { formatRelativeTime } from "@/utils/format";
import type { AutomationListItem, AutomationRunStatus, AutomationStatus } from "@/types/automation";

type AutomationListProps = {
  items: AutomationListItem[];
  nowMs: number;
  /** True when the empty state is the result of a search rather than of
   *  having built nothing — the two need different copy, and telling a
   *  tenant with twelve automations that they have none is the kind of
   *  small lie that makes a product feel broken. */
  filtered: boolean;
};

const STATUS_STYLE: Record<AutomationStatus, string> = {
  Active: "bg-teal-50 text-teal-700 ring-teal-100",
  Draft: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  Inactive: "bg-amber-50 text-amber-700 ring-amber-100",
};

const RUN_STYLE: Record<AutomationRunStatus, { label: string; className: string }> = {
  succeeded: { label: "ran fine", className: "text-teal-700" },
  skipped: { label: "skipped", className: "text-neutral-500" },
  failed: { label: "failed", className: "text-red-700" },
  stopped_by_safeguard: { label: "stopped by a safety limit", className: "text-amber-700" },
};

/**
 * The automations list. A Server Component — the rows are already
 * ordered, bounded and searched by getAutomationsPage, and nothing here
 * is interactive beyond the link into the builder.
 *
 * Follows the app's existing divided-list convention rather than a card
 * per row (RecentlyCaptured, InvitationList, MeetingNoteCard's action
 * items).
 */
export function AutomationList({ items, nowMs, filtered }: AutomationListProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-2xl bg-white px-4 py-10 text-center shadow-sm ring-1 ring-black/5">
        <p className="text-sm text-neutral-500">
          {filtered
            ? "No automation matches that search."
            : "No automations yet. Create one and it will run on its own for every new lead."}
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-neutral-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      {items.map((item) => {
        const run = item.last_run_status ? RUN_STYLE[item.last_run_status] : null;
        // Some automations in this account (created before a distinct
        // description was ever required, or by an admin who just typed
        // the name again into both fields) genuinely have description
        // === name stored — not a rendering bug reproducing empty
        // state, an identical string in both columns. Either way, a
        // description line that says nothing the title didn't already
        // say is never worth its own row.
        const hasDistinctDescription = Boolean(item.description && item.description.trim() !== item.name.trim());

        return (
          <li key={item.id}>
            <Link
              href={`/automations/${item.id}`}
              className="flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500/40 focus-visible:outline-none"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-neutral-900">{item.name}</span>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase ring-1 ring-inset ${STATUS_STYLE[item.status]}`}
                  >
                    {item.status}
                  </span>
                  {/* Recorded for history only — nothing in the
                      execution path reads it. Shown because an admin
                      auditing their own account should be able to see
                      which of these they wrote by hand. */}
                  {item.origin === "AI" ? (
                    <span className="inline-flex shrink-0 items-center rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold tracking-wide text-violet-700 uppercase ring-1 ring-inset ring-violet-100">
                      AI draft
                    </span>
                  ) : null}
                </p>
                {hasDistinctDescription ? (
                  <p className="mt-0.5 truncate text-xs text-neutral-500">{item.description}</p>
                ) : null}
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                  <span>
                    {item.latest_version > 0 ? `${item.latest_version} version${item.latest_version === 1 ? "" : "s"}` : "Not saved yet"}
                  </span>
                  {run && item.last_run_at ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className={run.className}>
                        last {run.label} {formatRelativeTime(item.last_run_at, nowMs)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>never run</span>
                    </>
                  )}
                </p>
              </div>
              <span aria-hidden="true" className="shrink-0 text-xs font-semibold text-sky-600">
                Open
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
