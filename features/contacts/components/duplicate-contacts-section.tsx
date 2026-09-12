"use client";

import { useState } from "react";
import { MessageBanner } from "@/components/shared/message-banner";
import { dismissDuplicateAction } from "../actions";
import type { DuplicatePair } from "../lib/duplicate-detection";
import type { DuplicateCandidateContact } from "../lib/get-contacts";

type DuplicateContactsSectionProps = {
  /** Computed once server-side (getPossibleDuplicatesAction, already
   *  customer-scoped and already filtered against
   *  contact_duplicate_dismissals) so first paint has no loading flash.
   *  Dismissal is handled entirely client-side from here — removing a
   *  pair from THIS component's own local state the moment the dismiss
   *  write succeeds, rather than re-running detection over the network,
   *  since nothing about the underlying candidate set changed. */
  initialPairs: DuplicatePair[];
};

function contactSummary(contact: DuplicateCandidateContact): string {
  return [contact.company, contact.title].filter(Boolean).join(" · ");
}

export function DuplicateContactsSection({ initialPairs }: DuplicateContactsSectionProps) {
  const [pairs, setPairs] = useState(initialPairs);
  const [pendingPairKey, setPendingPairKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mergeNoticePairKey, setMergeNoticePairKey] = useState<string | null>(null);

  if (pairs.length === 0) {
    return null;
  }

  function pairKey(pair: DuplicatePair): string {
    return `${pair.contactA.id}|${pair.contactB.id}`;
  }

  async function handleNotDuplicate(pair: DuplicatePair) {
    const key = pairKey(pair);
    setPendingPairKey(key);
    setActionError(null);

    const result = await dismissDuplicateAction(pair.contactA.id, pair.contactB.id);

    setPendingPairKey(null);
    if (!result.success) {
      setActionError(result.error ?? "Unable to dismiss this pair. Please try again.");
      return;
    }

    setPairs((current) => current.filter((p) => pairKey(p) !== key));
  }

  // No merge business rules exist anywhere in this app yet (which record
  // survives, field precedence, related-record handling) — performing a
  // destructive merge here would mean inventing those rules unilaterally,
  // which the spec explicitly disallows. The button stays, matching the
  // reference design, but only ever shows this notice — it never writes
  // to the database.
  function handleMergeRecords(pair: DuplicatePair) {
    setMergeNoticePairKey(pairKey(pair));
    setTimeout(() => setMergeNoticePairKey((current) => (current === pairKey(pair) ? null : current)), 4000);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-bold tracking-wider text-neutral-500 uppercase">Possible duplicate contacts</p>

      {actionError ? <MessageBanner tone="error">{actionError}</MessageBanner> : null}

      <div className="flex flex-col gap-4">
        {pairs.map((pair) => {
          const key = pairKey(pair);
          const isPending = pendingPairKey === key;

          return (
            <div key={key} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <DuplicateContactCard contact={pair.contactA} />
                <span className="shrink-0 self-center text-xs font-bold tracking-wide text-neutral-400 uppercase">
                  vs
                </span>
                <DuplicateContactCard contact={pair.contactB} />
              </div>

              {mergeNoticePairKey === key ? (
                <div className="mt-3">
                  <MessageBanner tone="warning">
                    Contact merge rules are not configured yet. No records were changed.
                  </MessageBanner>
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => handleMergeRecords(pair)}
                  className="min-h-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md"
                >
                  Merge records
                </button>
                <button
                  type="button"
                  onClick={() => handleNotDuplicate(pair)}
                  disabled={isPending}
                  className="min-h-10 rounded-full border border-neutral-300 px-4 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isPending ? "Dismissing..." : "Not a duplicate"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DuplicateContactCard({ contact }: { contact: DuplicateCandidateContact }) {
  const summary = contactSummary(contact);
  return (
    <div className="min-w-0 flex-1 rounded-xl bg-neutral-50 p-3.5">
      <p className="truncate text-sm font-semibold text-neutral-900">{contact.name}</p>
      {summary ? <p className="truncate text-sm text-neutral-500">{summary}</p> : null}
      {contact.email ? <p className="truncate text-xs text-neutral-500">{contact.email}</p> : null}
      {contact.phone ? <p className="truncate text-xs text-neutral-500">{contact.phone}</p> : null}
    </div>
  );
}
