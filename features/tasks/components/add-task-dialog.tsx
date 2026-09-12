"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useActionState } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { TasksIcon } from "@/features/sales-management/components/icons";
import { createTaskAction } from "../actions";
import { initialTaskFormState } from "../form-state";
import { TaskFormFields, TaskFormSubmitButton } from "./task-form-fields";
import type { TeamDirectoryEntry } from "@/types/lead";

type AddTaskDialogProps = {
  assignableUsers: TeamDirectoryEntry[];
  currentUserCustomerUserId: string;
  /** Preselects the Lead field — set when this dialog is opened from a
   *  Lead's own "Add Task" action (see EditLeadDialog, and the List
   *  view's own Activity icon) rather than from the Tasks page's own
   *  toolbar. The caller already has the one Lead object this applies
   *  to, so it passes the id + an already-formatted label directly —
   *  no need to thread the full customer Lead list through here just
   *  for this one preselect. */
  defaultLead?: { id: string; label: string };
  /** Defaults to "New task" (the Tasks page's own toolbar trigger). A
   *  caller opening this for a specific, already-known Lead (Edit Lead's
   *  "Add Task", the List view's Activity icon) passes something more
   *  specific — e.g. "Create task for Manjit" — so the dialog itself
   *  confirms which Lead the task is for at a glance. */
  title?: string;
  /** Renders the trigger element; receives a function that opens this
   *  dialog. The Tasks page and a Lead's "Add Task" action each render
   *  their own trigger styling/label via this, while both share this
   *  exact same form/action underneath — "reuse the same task creation
   *  component" (never a second task-creation implementation). */
  renderTrigger: (open: () => void) => ReactNode;
  /** Called after a successful create (in addition to closing the
   *  dialog and showing the success toast) — TaskList uses this to bump
   *  its shared refreshToken, so every TaskGroupSection re-fetches and
   *  the new task shows up without the user navigating away and back.
   *  Optional so this dialog still works if a future consumer has no
   *  such list to refresh. */
  onSuccess?: () => void;
};

/**
 * One real INSERT into public.tasks via createTaskAction, RLS +
 * composite same-customer-safe lead/assignee FKs enforcing tenant and
 * hierarchy isolation underneath. Mounted only while open, so each open
 * starts from a clean, empty form — including right after a successful
 * create, matching CreateLeadDialog's own render-time close pattern
 * (this dialog's own isOpen state, safe to adjust during render since
 * it's self-owned, not a caller's).
 */
export function AddTaskDialog({
  assignableUsers,
  currentUserCustomerUserId,
  defaultLead,
  title = "New task",
  renderTrigger,
  onSuccess,
}: AddTaskDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [state, formAction] = useActionState(createTaskAction, initialTaskFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Close-on-success (self-owned isOpen, safe to adjust during render —
  // see the file-level comment) and show a toast, matching
  // CreateLeadDialog's own identical pattern. A failed create leaves
  // isOpen untouched, so the dialog stays open with the user's entered
  // values intact (React form state persists across a failed action
  // call — nothing here clears the inputs) and state.formError renders
  // below.
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success && isOpen) {
      setIsOpen(false);
      setShowSuccessToast(true);
    }
  }

  // The toast outlives the dialog (which unmounts on close), so it's a
  // sibling of the Modal, not something rendered inside it — and it
  // self-dismisses rather than requiring the user to notice/close it.
  useEffect(() => {
    if (!showSuccessToast) return;
    const timer = setTimeout(() => setShowSuccessToast(false), 4000);
    return () => clearTimeout(timer);
  }, [showSuccessToast]);

  // onSuccess calls into the PARENT (TaskList bumping its shared
  // refreshToken) — must happen in an effect, not during this
  // component's own render: that's the same "Cannot update a component
  // while rendering a different component" hazard EditLeadDialog's own
  // onClose comment warns about (the isOpen/showSuccessToast handling
  // above is a different, safe case only because both are this
  // component's own state).
  useEffect(() => {
    if (state.success) {
      onSuccess?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSuccess intentionally excluded: a fresh closure every parent render, re-running this effect for that alone would re-fire onSuccess without state actually changing
  }, [state]);

  return (
    <>
      {renderTrigger(() => setIsOpen(true))}

      {isOpen ? (
        <Modal
          title={title}
          subtitle="Create a follow-up action for this lead."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 ring-1 ring-sky-100">
              <TasksIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setIsOpen(false)}
        >
          <form action={formAction} className="flex flex-col gap-5">
            <TaskFormFields
              assignableUsers={assignableUsers}
              currentUserCustomerUserId={currentUserCustomerUserId}
              fieldErrors={fieldErrors}
              defaultLead={defaultLead}
            />

            {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

            <div className="sticky bottom-0 -mx-6 -mb-5 flex justify-end gap-3 border-t border-neutral-100 bg-white px-6 py-4">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
              >
                Cancel
              </button>
              <TaskFormSubmitButton idleLabel="Add task" pendingLabel="Adding..." />
            </div>
          </form>
        </Modal>
      ) : null}

      {showSuccessToast ? (
        <div className="fixed right-6 bottom-6 z-[1100] w-full max-w-xs shadow-lg">
          <MessageBanner tone="success">Task created successfully.</MessageBanner>
        </div>
      ) : null}
    </>
  );
}
