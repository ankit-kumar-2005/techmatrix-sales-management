import { formatRelativeTime } from "@/utils/format";

type SourceCardProps = {
  name: string;
  /** Short line under the name — what this source actually feeds in. */
  description: string;
  connected: boolean;
  /** Connected but paused. Rendered as its own state rather than as
   *  "not connected", because the URL is still installed in IndiaMART
   *  and the distinction is what tells an admin whether they need to go
   *  back there. */
  paused?: boolean;
  todayCount: number;
  weekCount: number;
  lastReceivedAt: string | null;
  /** Server-resolved clock, threaded in so the server HTML and the
   *  client hydration agree. See formatRelativeTime. */
  nowMs: number;
  /** Two initials for the source badge — no third-party logos are
   *  bundled, and a letter mark in the app's own gradient reads as part
   *  of this product rather than as a pasted-in brand asset. */
  mark: string;
};

/**
 * One connected lead source.
 *
 * NO "SYNC NOW" BUTTON, and not as an oversight: IndiaMART pushes to a
 * webhook, so there is no remote list this app could pull on demand. A
 * sync control would be a button that cannot do anything. "Last lead
 * received" answers the question that button was there to answer —
 * "is this actually working?" — with something true.
 */
export function SourceCard({
  name,
  description,
  connected,
  paused = false,
  todayCount,
  weekCount,
  lastReceivedAt,
  nowMs,
  mark,
}: SourceCardProps) {
  const statusLabel = !connected ? "NOT CONNECTED" : paused ? "PAUSED" : "CONNECTED";

  // Reuses the app's existing status-pill shape (CatalogItemCard) and
  // its existing colour meanings — teal for live, amber for needs
  // attention, neutral for inert. No new palette.
  const statusClass = !connected
    ? "bg-neutral-100 text-neutral-500 ring-neutral-200"
    : paused
      ? "bg-amber-50 text-amber-700 ring-amber-100"
      : "bg-teal-50 text-teal-700 ring-teal-100";

  const dotClass = !connected ? "bg-neutral-400" : paused ? "bg-amber-500" : "bg-teal-500";

  return (
    <div className="flex h-full flex-col rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-xs font-bold text-white shadow-sm"
        >
          {mark}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-neutral-900">{name}</h3>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ring-1 ring-inset ${statusClass}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-neutral-500">{description}</p>
        </div>
      </div>

      <dl className="mt-4 flex items-baseline gap-6">
        <div>
          <dd className="text-2xl font-bold text-neutral-900">{todayCount}</dd>
          <dt className="mt-0.5 text-[10px] font-bold tracking-wide text-neutral-400 uppercase">Today</dt>
        </div>
        <div>
          <dd className="text-2xl font-bold text-neutral-900">{weekCount}</dd>
          <dt className="mt-0.5 text-[10px] font-bold tracking-wide text-neutral-400 uppercase">This week</dt>
        </div>
      </dl>

      <p className="mt-4 text-xs text-neutral-500">
        {lastReceivedAt ? (
          <>
            Last lead received{" "}
            <span className="font-semibold text-neutral-700">{formatRelativeTime(lastReceivedAt, nowMs)}</span>
          </>
        ) : connected ? (
          "No leads received yet."
        ) : (
          "Connect this source to start capturing leads."
        )}
      </p>
    </div>
  );
}
