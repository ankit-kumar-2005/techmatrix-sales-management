"use client";

import { useActionState, useState } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { updateLeadAction } from "../actions";
import { initialLeadFormState } from "../form-state";
import { LeadFormFields, LeadFormSubmitButton } from "./lead-form-fields";
import type { CustomerLeadStage, Lead, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

type EditLeadDialogProps = {
  lead: Lead;
  stages: CustomerLeadStage[];
  owners: TeamDirectoryEntry[];
  role: CustomerRole;
  currentUserEmail: string;
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
export function EditLeadDialog({ lead, stages, owners, role, currentUserEmail, onClose }: EditLeadDialogProps) {
  const [state, formAction] = useActionState(updateLeadAction, initialLeadFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Same "adjust state during render" close-on-success pattern as
  // CreateLeadDialog / LeadStageSettings' StageDialog — no useEffect
  // needed.
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success) {
      onClose();
    }
  }

  return (
    <Modal title="Edit Lead" onClose={onClose}>
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
            stage_id: lead.stage_id,
            owner_id: lead.owner_id,
            source: lead.source,
            next_step: lead.next_step,
          }}
        />

        {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

        <div className="mt-2 flex justify-end gap-3">
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
    </Modal>
  );
}
