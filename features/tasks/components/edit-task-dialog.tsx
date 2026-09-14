"use client";

import { useActionState, useEffect } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { updateTaskAction } from "../actions";
import { initialTaskFormState } from "../form-state";
import { TaskFormFields, TaskFormSubmitButton } from "./task-form-fields";
import { TasksIcon } from "@/features/sales-management/components/icons";
import type { TaskListItem } from "../lib/get-tasks";
import type { TeamDirectoryEntry } from "@/types/lead";

type EditTaskDialogProps = {
  task: TaskListItem;
  /** Already resolved by the caller (TaskList already has this task's
   *  linked-lead label on hand from its own bounded leadLabels — the
   *  same bucket page this dialog was opened from), so this dialog no
   *  longer needs the full customer Lead list just to derive one string
   *  via .find(). */
  lockedLeadLabel: string;
  assignableUsers: TeamDirectoryEntry[];
  currentUserCustomerUserId: string;
  onClose: () => void;
};

/**
 * Tasks' Edit action — reuses TaskFormFields (the same component
 * AddTaskDialog uses), same "one shared fields component, two dialogs"
 * pattern EditLeadDialog/EditContactDialog already establish, never a
 * second Task form. Only ever mounted for a task TaskList has already
 * fetched (and therefore one the caller could already see under RLS's
 * "hierarchy-aware task visibility" policy), but that's a UX
 * convenience, not the security boundary — updateTaskAction and RLS's
 * "visible-hierarchy members can update a task" policy
 * (is_customer_user_visible(assigned_to) on both USING and WITH CHECK)
 * independently re-verify authorization on every submit, including
 * against whichever assignee the caller reassigns it to.
 */
export function EditTaskDialog({
  task,
  lockedLeadLabel,
  assignableUsers,
  currentUserCustomerUserId,
  onClose,
}: EditTaskDialogProps) {
  const [state, formAction] = useActionState(updateTaskAction, initialTaskFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Closing this dialog means calling the PARENT's (TaskList's)
  // setEditingTask(null) — a different component's state, so this must
  // happen in an effect, not during this component's own render — same
  // pattern and reasoning as EditLeadDialog/EditContactDialog's identical
  // effect.
  useEffect(() => {
    if (state.success) {
      onClose();
    }
  }, [state, onClose]);

  return (
    <Modal
      title="Edit Task"
      subtitle="Update this task's details."
      icon={
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 ring-1 ring-sky-100">
          <TasksIcon className="h-5 w-5" />
        </span>
      }
      onClose={onClose}
    >
      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="id" value={task.id} />

        <TaskFormFields
          assignableUsers={assignableUsers}
          currentUserCustomerUserId={currentUserCustomerUserId}
          fieldErrors={fieldErrors}
          lockedLeadLabel={lockedLeadLabel}
          defaultValues={{
            subject: task.subject,
            description: task.description,
            priority: task.priority,
            due_date: task.due_date,
            assigned_to: task.assigned_to,
            type: task.type,
            status: task.status,
          }}
        />

        {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

        <div className="sticky bottom-0 -mx-6 -mb-5 flex justify-end gap-3 border-t border-neutral-100 bg-white px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
          >
            Cancel
          </button>
          <TaskFormSubmitButton idleLabel="Save Changes" pendingLabel="Saving..." />
        </div>
      </form>
    </Modal>
  );
}
