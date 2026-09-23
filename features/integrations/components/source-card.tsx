"use client";

import { useId, useState } from "react";
import { formatRelativeTime } from "@/utils/format";
import { ChevronDownIcon } from "@/features/sales-management/components/icons";
import { WebhookUrlPanel } from "./webhook-url-panel";
import { ConnectIndiamartButton } from "./connect-indiamart-button";

type SourceCardProps = {
  name: string;
  /** Short line under the name — what this source actually feeds in. */
  description: string;
  connected: boolean;
  /** Connected but paused. Rendered as its own state rather than as
   *  "not connected", because the URL is still installed at the source
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
  /** Both null when `connected` is false — there is no row yet, so
   *  nothing to show inline except the Connect button. Both real when
   *  true: this card's own webhook URL, expanded in place. */
  integrationId: string | null;
  webhookUrl: string | null;
};

/**
 * One connected lead source — now expandable IN PLACE, the same
 * mechanic ComingSoonSourceCard already uses: one boolean, a clickable
 * header, content mounted only while open. This replaces what used to
 * be a single shared "Connection" section rendered separately at the
 * bottom of the page, disconnected from whichever card triggered it —
 * that only ever worked because IndiaMART was the one and only source.
 * With four cards, each needs its OWN connection details, inside its
 * OWN boundary, which is exactly what this does now.
 *
 * NO "SYNC NOW" BUTTON, and not as an oversight: every source this
 * feature supports pushes to a webhook, so there is no remote list this
 * app could pull on demand. A sync control would be a button that
 * cannot do anything. "Last lead received" answers the question that
 * button was there to answer — "is this actually working?" — with
 * something true.
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
  integrationId,
  webhookUrl,
}: SourceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

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
  // Live only for the genuinely live state — not paused, not
  // disconnected. A slowed, restrained animate-pulse (the same utility
  // Skeleton loaders already use elsewhere, just applied to a 6px dot
  // instead of a whole placeholder block) rather than anything louder
  // like a ping-ring: it should read as "this is quietly working," not
  // draw the eye. Respects prefers-reduced-motion via the same
  // motion-reduce:animate-none pairing already established on every
  // other animated element in this app.
  const isLive = connected && !paused;

  return (
    <div
      className={`rounded-2xl bg-white shadow-sm ring-1 ring-black/5 transition-all duration-200 ${
        expanded ? "" : "hover:-translate-y-0.5 hover:shadow-md"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full flex-col p-5 text-left"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-xs font-bold text-white shadow-sm"
          >
            {mark}
          </span>
          <div className="min-w-0 flex-1">
            {/* Name and status pill each get their OWN line, rather than
                sharing one row that wraps unpredictably — in a narrow
                grid column, "IndiaMART" + "CONNECTED" is too wide for
                one line, and letting them compete for space either
                truncates the name (illegible) or wraps at a different
                point per card (uneven height). Stacked, every card gets
                the same fixed anatomy: name line, pill line, then up to
                2 lines of description. */}
            <h3 className="truncate text-base font-semibold text-neutral-900">{name}</h3>
            <span
              className={`mt-1 inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ring-1 ring-inset ${statusClass}`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass} ${
                  isLive ? "animate-[pulse_2.5s_ease-in-out_infinite] motion-reduce:animate-none" : ""
                }`}
                aria-hidden="true"
              />
              {statusLabel}
            </span>
            {/* Clamped to 2 lines — in a 4-across grid each card is
                narrow enough that description length alone would
                otherwise make cards of noticeably different heights;
                a shared cap keeps every card's collapsed height close
                regardless of exact wording length. */}
            <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-neutral-500">{description}</p>
          </div>
          <span className="sr-only">{expanded ? `Collapse ${name} connection details` : `Show ${name} connection details`}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className={`mt-1 h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
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
      </button>

      {expanded ? (
        <div id={panelId} className="border-t border-neutral-100 p-5">
          {connected && integrationId && webhookUrl ? (
            <WebhookUrlPanel integrationId={integrationId} webhookUrl={webhookUrl} sourceName={name} />
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm leading-relaxed text-neutral-500">
                Connecting generates a private webhook URL to paste into {name}&rsquo;s Push API page. Enquiries then
                arrive as leads automatically — no manual import, and nothing to sync.
              </p>
              <div>
                <ConnectIndiamartButton sourceName={name} />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
