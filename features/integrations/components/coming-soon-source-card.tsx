"use client";

import { useId, useState } from "react";
import { ChevronDownIcon, GlobeIcon } from "@/features/sales-management/components/icons";
import { WebhookUrlPanel } from "./webhook-url-panel";
import type { ComingSoonSourceMetadata } from "../lib/providers/coming-soon-sources";

type ComingSoonSourceCardProps = {
  source: ComingSoonSourceMetadata;
  /** Real — a row genuinely exists for this source (see
   *  ensure-coming-soon-integration.ts), provisioned automatically
   *  ahead of any admin ever seeing this card. */
  integrationId: string;
  /** Real, full, unmasked webhook URL — same as IndiaMART's own. There
   *  is simply no adapter registered to answer it yet. */
  webhookUrl: string;
};

/**
 * A "Soon" sibling to SourceCard — deliberately NOT SourceCard itself.
 * SourceCard's not-connected footer copy ("Connect this source to
 * start capturing leads.") is a real affordance this card must never
 * make, since there is nothing to connect — a real row already exists
 * the moment this card is ever shown. Same badge treatment as the real
 * card (one plain letter/icon mark in the app's existing gradient, no
 * separate "muted" badge style) — the "not real yet" signal comes from
 * the dashed border and the "Soon" chip, not from degrading the mark.
 *
 * EXPANDS TO THE IDENTICAL CONNECTION PANEL IndiaMART'S OWN CARD USES —
 * WebhookUrlPanel, unmodified as a component, just told `comingSoon`
 * (see that component's own note on exactly what that changes: Test
 * Connection short-circuits to a friendly message instead of actually
 * reaching out, a "Soon" chip stays visible next to "Private", and the
 * Setup Guide shows this source's own draft steps instead of
 * IndiaMART's real ones — Copy and Regenerate are fully real and
 * unchanged, because the URL and the row backing it genuinely are).
 *
 * ALREADY FULL WIDTH, COLLAPSED OR EXPANDED — "Connected sources" is a
 * single stacked column (see the lead-capture page's own note on why),
 * so this card never has a row-mate whose height it could clash with;
 * expanding only ever makes IT taller in place, never moves anything
 * else on the page.
 *
 * SAME COLLAPSED SILHOUETTE AS SourceCard — the stat row and its
 * closing line below the description use SourceCard's own markup and
 * classes verbatim (dashes and "Not connected yet" in place of real
 * numbers, since there is no adapter listening to count anything yet),
 * so every card in the stacked column renders at the identical height
 * regardless of whether it's the one real, connected source or one of
 * the three "Soon" ones.
 */
export function ComingSoonSourceCard({ source, integrationId, webhookUrl }: ComingSoonSourceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  return (
    <div
      className={`rounded-2xl border border-dashed transition-colors duration-200 ${
        expanded ? "border-sky-300 bg-sky-50/40" : "border-neutral-200 bg-white"
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
            {source.useGlobeIcon ? <GlobeIcon className="h-5 w-5" /> : source.initials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-neutral-900">{source.displayName}</span>
              <span className="inline-flex shrink-0 items-center rounded-full bg-neutral-100 px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-neutral-500 uppercase ring-1 ring-inset ring-neutral-200">
                Soon
              </span>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-neutral-500">{source.description}</p>
          </div>
          <span className="sr-only">
            {expanded ? `Collapse ${source.displayName} connection details` : `Show ${source.displayName} connection details`}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={`mt-0.5 h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>

        <dl className="mt-4 flex items-baseline gap-6">
          <div>
            <dd className="text-2xl font-bold text-neutral-300">—</dd>
            <dt className="mt-0.5 text-[10px] font-bold tracking-wide text-neutral-400 uppercase">Today</dt>
          </div>
          <div>
            <dd className="text-2xl font-bold text-neutral-300">—</dd>
            <dt className="mt-0.5 text-[10px] font-bold tracking-wide text-neutral-400 uppercase">This week</dt>
          </div>
        </dl>

        <p className="mt-4 text-xs text-neutral-500">Not connected yet — no leads captured.</p>
      </button>

      {expanded ? (
        <div id={panelId} className="border-t border-neutral-100 p-5">
          <WebhookUrlPanel
            integrationId={integrationId}
            webhookUrl={webhookUrl}
            sourceName={source.displayName}
            comingSoon
            draftSteps={source.setupSteps}
          />
        </div>
      ) : null}
    </div>
  );
}
