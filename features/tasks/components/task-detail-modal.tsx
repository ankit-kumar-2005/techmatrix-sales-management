"use client";

import { Modal } from "@/components/shared/modal";
import { formatLeadLabel, type LeadLabel } from "@/features/leads/lib/get-lead-labels";
import { dateFormatter } from "@/utils/format";
import type { TaskListItem } from "../lib/get-tasks";

type OwnerDisplay = { label: string; initials: string; tooltip: string };

type TaskDetailModalProps = {
  task: TaskListItem;
  lead?: LeadLabel;
  assignee?: OwnerDisplay;
  onComplete: () => void;
  onClose: () => void;
};

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

const createdAtFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * Read-only task details, plus a Complete action for a still-Pending
 * task — calls TaskList's own onComplete (the same completeTaskAction
 * its checkbox calls, including its optimistic-update/rollback-with-
 * toast handling), not a second completion path. Closes immediately
 * rather than waiting on the round trip, the same optimistic-first
 * pattern the checkbox itself uses — any failure surfaces via the same
 * page-level toast either way. Reuses the shared Modal primitive rather
 * than a dedicated drawer, matching every other detail/edit surface in
 * this app (EditLeadDialog, the New Catalog Item dialog).
 */
export function TaskDetailModal({ task, lead, assignee, onComplete, onClose }: TaskDetailModalProps) {
  const isCompleted = task.status === "Completed";

  function handleComplete() {
    onComplete();
    onClose();
  }

  return (
    <Modal title="Task Details" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Subject</p>
          <p className="mt-1 text-sm font-semibold text-neutral-900">{task.subject}</p>
        </div>

        {task.description ? (
          <div>
            <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Description</p>
            <p className="mt-1 text-sm whitespace-pre-wrap text-neutral-700">{task.description}</p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Priority</p>
            <p className="mt-1 text-sm text-neutral-700">{task.priority}</p>
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Type</p>
            <p className="mt-1 text-sm text-neutral-700">{task.type}</p>
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Due Date</p>
            <p className="mt-1 text-sm text-neutral-700">{dateFormatter.format(parseDateOnly(task.due_date))}</p>
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Status</p>
            <p className={`mt-1 text-sm font-medium ${isCompleted ? "text-emerald-600" : "text-neutral-700"}`}>
              {task.status}
            </p>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Assigned User</p>
          <p className="mt-1 text-sm text-neutral-700">{assignee?.label ?? "—"}</p>
        </div>

        <div>
          <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Lead</p>
          <p className="mt-1 text-sm text-neutral-700">{lead ? formatLeadLabel(lead) : "—"}</p>
        </div>

        <div>
          <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Created At</p>
          <p className="mt-1 text-sm text-neutral-700">{createdAtFormatter.format(new Date(task.created_at))}</p>
        </div>

        <div className="mt-2 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
          >
            Close
          </button>
          {!isCompleted ? (
            <button
              type="button"
              onClick={handleComplete}
              className="min-h-11 rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700"
            >
              Mark complete
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
