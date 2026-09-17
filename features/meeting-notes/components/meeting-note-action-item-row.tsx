"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AddTaskDialog } from "@/features/tasks/components/add-task-dialog";
import { CalendarIcon, CheckIcon, ContactsIcon, FlagIcon } from "@/features/sales-management/components/icons";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { MeetingNoteActionItem } from "@/types/meeting-note";
import type { AssigneeMatch } from "../lib/match-assignee";
import { linkActionItemToTaskAction } from "../actions";

type MeetingNoteActionItemRowProps = {
  item: MeetingNoteActionItem;
  /** Passed straight to the existing dialog's Assign picker. */
  assignableUsers: TeamDirectoryEntry[];
  currentUserCustomerUserId: string;
  /** Computed SERVER-side by matchSuggestedAssignee, so Fuse and the
   *  whole directory stay out of this feature's client bundle. Null when
   *  the source named nobody. */
  assigneeMatch: AssigneeMatch | null;
  /** For the dialog subtitle, so it says which meeting this came from
   *  rather than the default "for this lead" — there is no lead. */
  noteTitle: string;
  /** Today, resolved on the SERVER and passed down. Comparing dates
   *  against a client clock would render differently on the server and
   *  the client for anyone whose timezone puts them on a different
   *  calendar day, which is a hydration mismatch — and it would also let
   *  a wrong local clock invent or hide an overdue badge. */
  todayIso: string;
};

const PILL = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase";

const PRIORITY_PILL: Record<string, string> = {
  High: "bg-rose-50 text-rose-700 ring-1 ring-rose-100",
  Medium: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
  Low: "bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200",
};

const shortDateFormatter = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

/** yyyy-mm-dd parsed at UTC noon, not local midnight: new Date("2026-08-23")
 *  is UTC midnight and renders as the PREVIOUS day west of UTC. */
function formatShortDate(value: string): string {
  return shortDateFormatter.format(new Date(`${value}T12:00:00Z`));
}

/**
 * One action item, and the checkbox that turns it into a real task.
 *
 * THE CHECKBOX IS THE DIALOG'S TRIGGER. AddTaskDialog owns its own open
 * state and exposes it only through renderTrigger(open) — so rather than
 * adding a controlled-open prop to a component three other features
 * already depend on, the checkbox's own onChange calls that open()
 * callback. Nothing about how the dialog opens changed.
 *
 * TICKING CREATES NOTHING BY ITSELF. It opens the form. The task is
 * created by the existing createTaskAction when the user submits, with
 * the Lead and Assign pickers still theirs to fill in — assignee
 * defaults to the current user exactly as it does everywhere else, and
 * the fuzzy match only annotates an option. Only after that save
 * succeeds does this row record task_id.
 *
 * The checkbox is deliberately NOT optimistically checked on click: it
 * reflects task_id, which is only true once a task genuinely exists. A
 * user who opens the dialog and cancels must find the item exactly as
 * they left it.
 */
export function MeetingNoteActionItemRow({
  item,
  assignableUsers,
  currentUserCustomerUserId,
  assigneeMatch,
  noteTitle,
  todayIso,
}: MeetingNoteActionItemRowProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [linkError, setLinkError] = useState<string | null>(null);
  const isLinked = item.task_id !== null;

  /** A suggested date already in the past. String comparison is exact
   *  and timezone-free here because both sides are ISO yyyy-mm-dd — no
   *  Date object, no parsing, no drift. Only flagged while the item is
   *  still OUTSTANDING: once a task exists the date lives on the task,
   *  and nagging about a handled item is noise. */
  const isOverdue = !isLinked && item.suggested_due_date !== null && item.suggested_due_date < todayIso;

  function handleTaskCreated(taskId: string | undefined) {
    if (!taskId) {
      // createTaskAction succeeded but reported no id. The task exists —
      // that is the thing the user wanted — so this is stated plainly
      // rather than dressed up as a failure.
      setLinkError("The task was created, but couldn't be linked back to this item. Refresh to check.");
      router.refresh();
      return;
    }

    setLinkError(null);
    startTransition(async () => {
      const result = await linkActionItemToTaskAction(item.id, taskId);
      if (!result.success) {
        setLinkError(result.error ?? "The task was created, but linking it here failed.");
      }
      // Refreshed either way: the task list and the Tasks page are now
      // stale regardless of whether the link landed.
      router.refresh();
    });
  }

  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <AddTaskDialog
        assignableUsers={assignableUsers}
        currentUserCustomerUserId={currentUserCustomerUserId}
        title="Create task from action item"
        subtitle={`From "${noteTitle}". Pick a lead and confirm the assignee.`}
        prefill={{
          subject: item.subject,
          description: item.description,
          priority: item.suggested_priority,
          // A suggested date the model could not anchor is null, and it
          // stays null here: tasks.due_date is NOT NULL, so the user
          // must choose one. Inventing "today" would turn a guess into a
          // real deadline nobody set.
          due_date: item.suggested_due_date,
          type: item.suggested_type,
        }}
        assigneeHint={assigneeMatch ?? undefined}
        onSuccess={handleTaskCreated}
        renderTrigger={(open) => (
          <input
            type="checkbox"
            checked={isLinked}
            disabled={isLinked || isPending}
            onChange={() => open()}
            aria-label={
              isLinked
                ? `A task already exists for: ${item.subject}`
                : `Create a task from: ${item.subject}`
            }
            title={isLinked ? "A task already exists for this action item." : "Create a task from this action item"}
            className={`mt-0.5 h-4 w-4 shrink-0 rounded border-neutral-300 accent-emerald-600 ${
              isLinked || isPending ? "cursor-not-allowed" : "cursor-pointer"
            }`}
          />
        )}
      />

      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${isLinked ? "text-neutral-400 line-through" : "text-neutral-800"}`}>
          {item.subject}
        </p>
        {item.description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{item.description}</p>
        ) : null}
        {linkError ? (
          <p role="alert" className="mt-1 text-xs text-amber-700">
            {linkError}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <span className={`${PILL} ${PRIORITY_PILL[item.suggested_priority] ?? PRIORITY_PILL.Medium}`}>
          <FlagIcon className="h-2.5 w-2.5" />
          {item.suggested_priority}
        </span>
        {/* ON YOUR TEAM vs. NOT, distinguished by FILL and an icon
            rather than by a new color family:
              matched   -> filled neutral chip + a people icon
              unmatched -> dashed outline on white, no icon
            That answers the question a rep actually scans for ("which of
            these am I waiting on someone else for") while staying inside
            the neutral palette this app already uses for these chips.

            THE LABELS ARE DELIBERATELY NOT "internal"/"external". The
            signal is "matched a teammate you can assign to" — a genuine
            teammate outside YOUR reporting hierarchy also won't match,
            because the directory is hierarchy-scoped. Calling that
            person "external" would assert something false, so the
            tooltip says what is actually known instead. */}
        {item.suggested_assignee ? (
          <span
            title={
              assigneeMatch?.matchedCustomerUserId
                ? "Matches a teammate you can assign to — confirm in the dialog."
                : "No teammate in your hierarchy matched this name, so it's likely someone outside your team."
            }
            className={
              assigneeMatch?.matchedCustomerUserId
                ? "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700"
                : "inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-500"
            }
          >
            {assigneeMatch?.matchedCustomerUserId ? <ContactsIcon className="h-3 w-3 shrink-0" /> : null}
            {item.suggested_assignee}
          </span>
        ) : null}
        {item.suggested_due_date ? (
          /* An already-passed date gets the same amber treatment the
             Forecast chart uses for its Overdue bucket and the
             by-stage table uses for a 0% stage — the app's established
             "needs attention" language, not a new one. */
          <span
            title={isOverdue ? "This suggested date has already passed." : undefined}
            className={
              isOverdue
                ? "inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-100"
                : "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600"
            }
          >
            <CalendarIcon className="h-3 w-3" />
            {formatShortDate(item.suggested_due_date)}
            {isOverdue ? <span className="sr-only"> (overdue)</span> : null}
          </span>
        ) : null}
        {isLinked ? (
          <span className={`${PILL} bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100`}>
            <CheckIcon className="h-2.5 w-2.5" />
            Task created
          </span>
        ) : null}
      </div>
    </li>
  );
}
