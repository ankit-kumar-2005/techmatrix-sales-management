import { CalendarIcon, CheckIcon, ContactsIcon } from "@/features/sales-management/components/icons";
import { getOwnerDisplayLabels } from "@/features/leads/lib/owner-display";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { MeetingNoteListItem } from "../lib/get-meeting-notes";
import { matchSuggestedAssignee } from "../lib/match-assignee";
import { MeetingNoteActionItemRow } from "./meeting-note-action-item-row";
import { MeetingNoteCardShell } from "./meeting-note-card-shell";

type MeetingNoteCardProps = {
  note: MeetingNoteListItem;
  /** From the existing get_visible_team_directory() RPC — names the
   *  note's owner and feeds the task dialog's Assign picker. It never
   *  decides what is rendered; RLS already decided which notes arrived. */
  owners: TeamDirectoryEntry[];
  /** The viewer's own customer_users.id — the Assign picker's default
   *  inside the task dialog, exactly as on every other caller. */
  currentUserCustomerUserId: string;
  /** Only the newest note on page 1. Everything else starts collapsed. */
  defaultExpanded: boolean;
  /** Today, resolved ONCE on the server and threaded down so every
   *  overdue badge on the page agrees — and so a client clock can never
   *  disagree with the server render and cause a hydration mismatch. */
  todayIso: string;
};

/** Same pill geometry every badge in this app uses (TaskRow's
 *  priority/due/completed chips): rounded-full, text-[10px], bold,
 *  uppercase, tinted with a matching ring. */
const PILL = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase";

const dateFormatter = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** yyyy-mm-dd parsed at UTC noon, not local midnight: new Date("2026-08-23")
 *  is UTC midnight and renders as the PREVIOUS day west of UTC. */
function formatMeetingDate(value: string): string {
  return dateFormatter.format(new Date(`${value}T12:00:00Z`));
}

/**
 * One meeting note, collapsed by default.
 *
 * STILL A SERVER COMPONENT. Everything expensive or secret stays here:
 * the fuzzy assignee match (fuse.js — verified absent from the client
 * bundle), the completion arithmetic, the date formatting. The only
 * client state in the card layer is one boolean inside
 * MeetingNoteCardShell, which receives both halves already rendered.
 *
 * COMPLETION IS COMPUTED FROM DATA ALREADY LOADED — no extra query.
 * task_id being non-null IS the converted signal (it is the only link
 * between an action item and a real task), so "2 of 4 done" is a filter
 * over rows the list already fetched.
 */
export function MeetingNoteCard({
  note,
  owners,
  currentUserCustomerUserId,
  defaultExpanded,
  todayIso,
}: MeetingNoteCardProps) {
  const ownerLabel = getOwnerDisplayLabels(owners).get(note.owner_id) ?? null;

  const total = note.action_items.length;
  const doneCount = note.action_items.filter((item) => item.task_id !== null).length;
  const allDone = total > 0 && doneCount === total;

  const header = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-neutral-900">{note.title}</h3>
        {/* This app's own accent — the blue-to-violet gradient already
            used for the active nav item and every primary button — NOT
            the reference screenshot's teal. */}
        <span className={`${PILL} bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-sm shadow-blue-600/20`}>
          AI Summary
        </span>
        {note.source_kind === "Image" ? (
          <span className={`${PILL} bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200`}>From image</span>
        ) : null}

        {/* THE COMPLETION SIGNAL — readable while collapsed, which is
            the whole point: a manager scanning past calls wants to know
            what is still outstanding without opening anything. Emerald
            only when genuinely finished; otherwise neutral, because the
            count already carries the urgency and ten amber pills down a
            list would read as ten warnings. */}
        {total > 0 ? (
          <span
            className={`${PILL} ${
              allDone
                ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
                : "bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200"
            }`}
          >
            {allDone ? <CheckIcon className="h-2.5 w-2.5" /> : null}
            {doneCount} of {total} done
          </span>
        ) : (
          <span className={`${PILL} bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200`}>No action items</span>
        )}
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-neutral-500">
        {note.meeting_date ? (
          <span className="inline-flex items-center gap-1">
            <CalendarIcon className="h-3 w-3 shrink-0" />
            {formatMeetingDate(note.meeting_date)}
          </span>
        ) : (
          <span className="text-neutral-400">No date in the source</span>
        )}
        {note.attendees.length > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="inline-flex min-w-0 items-center gap-1">
              <ContactsIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{note.attendees.join(", ")}</span>
            </span>
          </>
        ) : null}
        {ownerLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">Recorded by {ownerLabel}</span>
          </>
        ) : null}
      </p>

      {/* The snippet. `truncate` rather than slicing in JS: the cut
          lands at the actual rendered width instead of an arbitrary
          character count, so it adapts to the viewport. */}
      <p className="mt-1.5 truncate text-sm text-neutral-500">{note.summary}</p>
    </>
  );

  const body = (
    <>
      {/* CONTEXT vs. ACTION, separated visually. The tint is the same
          white-to-blue-50 gradient family the Pipeline KPI cards already
          use, so it reads as this app's soft accent surface rather than
          a new color. What was discussed sits on it; what to do about it
          sits on plain white below. */}
      <div className="rounded-xl bg-gradient-to-br from-white to-blue-50 p-4 ring-1 ring-blue-100">
        {/* whitespace-pre-line, not a markdown renderer: this is model
            output and React escapes it here, so there is no
            HTML-injection surface. */}
        <p className="text-sm leading-relaxed whitespace-pre-line text-neutral-700">{note.summary}</p>
      </div>

      {total === 0 ? (
        <p className="mt-4 rounded-xl bg-neutral-50 px-4 py-3 text-xs text-neutral-500 ring-1 ring-neutral-100">
          No action items found in this source. The summary above is still saved.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-neutral-100">
          {note.action_items.map((item) => (
            <MeetingNoteActionItemRow
              key={item.id}
              item={item}
              assignableUsers={owners}
              currentUserCustomerUserId={currentUserCustomerUserId}
              assigneeMatch={matchSuggestedAssignee(item.suggested_assignee, owners)}
              noteTitle={note.title}
              todayIso={todayIso}
            />
          ))}
        </ul>
      )}

      {/* Unobtrusive, and on every card rather than only for fallbacks:
          the point is that tier reliability stays visible over time. A
          page where every card says "fallback tier 3" is the signal
          that tier 1 is effectively unavailable. */}
      <p className="mt-4 border-t border-neutral-100 pt-3 text-[11px] text-neutral-400">
        Extracted by {note.model_used}
        {note.tier === null
          ? " (no longer in the model chain)"
          : note.tier > 1
            ? ` — fallback tier ${note.tier}`
            : ""}
        . Review before acting.
      </p>
    </>
  );

  return <MeetingNoteCardShell header={header} body={body} defaultExpanded={defaultExpanded} title={note.title} />;
}
