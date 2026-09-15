"use client";

import { useActionState, useEffect } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { updateLeadAction } from "../actions";
import { initialLeadFormState } from "../form-state";
import { LeadFormFields, LeadFormSubmitButton } from "./lead-form-fields";
// The Tasks module's own creation dialog, reused as-is (not a second
// task-creation implementation) — see Section 26 of the Tasks spec:
// "Create Task from Lead" must reuse the same component, just with this
// lead preselected. defaultLead={{id, label}} (rather than threading the
// customer's entire lead list through this dialog too) makes that
// preselection the Lead field's only option, without needing a separate
// "locked" mode in TaskFormFields.
import { AddTaskDialog } from "@/features/tasks/components/add-task-dialog";
import { formatLeadLabel } from "@/features/leads/lib/get-lead-labels";
import type { PipelineLead } from "@/features/leads/lib/get-leads";
import { LeadCaptureIcon, PlusIcon } from "@/features/sales-management/components/icons";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

type EditLeadDialogProps = {
  lead: PipelineLead;
  stages: CustomerLeadStage[];
  owners: TeamDirectoryEntry[];
  role: CustomerRole;
  currentUserEmail: string;
  /** The caller's own customer_users.id — needed only to preselect the
   *  Assign field when opening the embedded "Add Task" dialog from
   *  here; every other use of this dialog resolves it itself. */
  currentUserCustomerUserId: string;
  onClose: () => void;
};

/**
 * The List View's Edit action. Only ever mounted by PipelineView for a
 * lead it has already determined is editable (closed_at is null, and
 * the caller is either an admin or the lead's own owner) — but that's a
 * UX convenience, not the security boundary. updateLeadAction
 * independently re-checks both, and the database (
 * protect_lead_stage_transition, leads_protect_owner_id_change, and the
 * "owners or admins can update a lead" RLS policy) is the layer that
 * actually holds if this check were ever wrong or bypassed.
 */
export function EditLeadDialog({
  lead,
  stages,
  owners,
  role,
  currentUserEmail,
  currentUserCustomerUserId,
  onClose,
}: EditLeadDialogProps) {
  const [state, formAction] = useActionState(updateLeadAction, initialLeadFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Closing this dialog means calling the PARENT's (PipelineView's)
  // setEditingLead(null) — a different component's state, not this
  // one's own. That must happen in an effect (after render commits),
  // never synchronously during this component's own render — doing it
  // during render is exactly what produces React's "Cannot update a
  // component while rendering a different component" error.
  // (CreateLeadDialog's similar-looking render-time pattern is safe
  // *only* because it adjusts its own local isOpen state, not a
  // caller-owned one — this component isn't that case.) The effect
  // re-fires only when `state` itself becomes a new object (a fresh
  // action result), so a successful save closes the dialog exactly
  // once; since that immediately unmounts this component (PipelineView
  // stops rendering it once editingLead is null), there's no later
  // render left for a changing `onClose` reference to matter.
  useEffect(() => {
    if (state.success) {
      onClose();
    }
  }, [state, onClose]);

  return (
    <Modal
      title="Edit Lead"
      subtitle="Update this lead's details."
      icon={
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 ring-1 ring-sky-100">
          <LeadCaptureIcon className="h-5 w-5" />
        </span>
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {/* Deliberately OUTSIDE the <form> below: AddTaskDialog renders
            its own <form> when open (via the shared, non-portaling Modal
            primitive — position: fixed, not a DOM portal), and a <form>
            nested inside another <form> is invalid HTML that browsers
            silently mishandle. Rendering the trigger as a sibling here,
            not a descendant of the Edit Lead <form>, is what keeps the
            two completely independent. */}
        <AddTaskDialog
          assignableUsers={owners}
          currentUserCustomerUserId={currentUserCustomerUserId}
          defaultLead={{ id: lead.id, label: formatLeadLabel(lead) }}
          renderTrigger={(open) => (
            <button
              type="button"
              onClick={open}
              className="flex items-center gap-1.5 self-start text-sm font-semibold text-sky-600 transition-colors hover:text-sky-700"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Add Task
            </button>
          )}
        />

        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={lead.id} />

          <LeadFormFields
            stages={stages}
            owners={owners}
            role={role}
            currentUserEmail={currentUserEmail}
            fieldErrors={fieldErrors}
            defaultValues={{
              contact_name: lead.contact_name,
              phone: lead.phone,
              whatsapp_phone: lead.whatsapp_phone,
              email: lead.email,
              company: lead.company,
              deal_value: lead.deal_value,
              expected_close_date: lead.expected_close_date,
              stage_id: lead.stage_id,
              owner_id: lead.owner_id,
              source: lead.source,
              next_step: lead.next_step,
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
            <LeadFormSubmitButton idleLabel="Save Changes" pendingLabel="Saving..." />
          </div>
        </form>
      </div>
    </Modal>
  );
}
