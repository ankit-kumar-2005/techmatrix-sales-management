import { getOwnerAvatarColor, getOwnerDisplayLabels, getOwnerInitials } from "@/features/leads/lib/owner-display";
import { getSourceMetadata } from "@/features/integrations/lib/providers/source-metadata";
import { formatRelativeTime } from "@/utils/format";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { CapturedLead, IntegrationSource } from "@/types/integration";

type RecentlyCapturedProps = {
  leads: CapturedLead[];
  /** For resolving owner_id to a display label — the same directory and
   *  the same label helpers the Pipeline Owner column uses, so a rep's
   *  name reads identically in both places. */
  owners: TeamDirectoryEntry[];
  /** The typed source, not a display string — this component resolves
   *  its own display name AND initials from the Phase 1 metadata
   *  registry, so a caller never has to know both a source's name and
   *  its badge letters separately. */
  source: IntegrationSource;
  nowMs: number;
};

/**
 * The capture activity feed. A Server Component — nothing here is
 * interactive, and the rows are already ordered and bounded by
 * getLeadCaptureOverview.
 *
 * Row styling follows the app's existing divided-list convention
 * (MeetingNoteCard's action items, InvitationList) rather than
 * introducing a card-per-row: these are log entries, not objects you
 * act on.
 */
export function RecentlyCaptured({ leads, owners, source, nowMs }: RecentlyCapturedProps) {
  const metadata = getSourceMetadata(source);
  const labelById = getOwnerDisplayLabels(owners);
  const ownerById = new Map(owners.map((owner) => [owner.customer_user_id, owner]));

  if (leads.length === 0) {
    return (
      <div className="rounded-2xl bg-white px-4 py-10 text-center shadow-sm ring-1 ring-black/5">
        <p className="text-sm text-neutral-500">
          Nothing captured yet. Once {metadata.displayName} posts its first lead it will appear here.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-neutral-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      {leads.map((lead) => {
        const owner = lead.owner_id ? ownerById.get(lead.owner_id) : undefined;
        return (
          <li key={lead.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            {/* Was a plain colored dot — now the source's own
                initials badge from the Phase 1 registry, matching the
                exact circle-badge shape the assignee chip two lines
                below already uses (same sizing, rounded-full, white
                text pattern, just the app's own gradient instead of a
                per-owner color, since there is only ever one visual
                identity per source). A future second source reads as a
                different two-letter badge automatically — nothing
                about this row's markup needs to change for it. */}
            <span
              aria-hidden="true"
              title={metadata.displayName}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-[8px] font-bold text-white"
            >
              {metadata.initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-neutral-900">
                {lead.company}
                {/* company can fall back to contact_name (a source's own
                    adapter, or ingest_lead()'s own last resort — see the
                    migration's design note 10), so the two can
                    legitimately be equal — showing the dash form twice
                    would read as a bug. */}
                {lead.contact_name && lead.contact_name !== lead.company ? (
                  <span className="font-medium text-neutral-500"> — {lead.contact_name}</span>
                ) : null}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                <span>{metadata.displayName}</span>
                <span aria-hidden="true">·</span>
                {owner ? (
                  <span className="inline-flex items-center gap-1">
                    <span
                      aria-hidden="true"
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white ${getOwnerAvatarColor(owner.customer_user_id)}`}
                    >
                      {getOwnerInitials(owner)}
                    </span>
                    assigned to {labelById.get(owner.customer_user_id) ?? owner.email}
                  </span>
                ) : (
                  /* Amber, the app's established "needs attention"
                     colour — an unassigned captured lead is exactly
                     that, and it is the signal an admin most needs on
                     this page. */
                  <span className="font-semibold text-amber-700">unassigned</span>
                )}
              </p>
            </div>
            <span className="shrink-0 text-xs text-neutral-400">
              {formatRelativeTime(lead.created_at, nowMs)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
