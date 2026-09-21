"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { SelectField } from "@/components/shared/select-field";
import { FormSection } from "@/components/shared/form-section";
import { MessageBanner } from "@/components/shared/message-banner";
import { TeamSelect } from "@/components/shared/team-select";
import { PipelineIcon, UserPlusIcon } from "@/features/sales-management/components/icons";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { AssignmentMode } from "@/types/integration";
import { updateIntegrationSettingsAction } from "../actions";
import { initialIntegrationFormState } from "../form-state";

type CaptureSettingsFormProps = {
  integrationId: string;
  stages: CustomerLeadStage[];
  assignableUsers: TeamDirectoryEntry[];
  defaultStageId: string | null;
  assignmentMode: AssignmentMode;
  defaultOwnerId: string | null;
  /** In rotation order — (created_at, id), the same order ingest_lead()
   *  walks for every source, not just this one. */
  participantIds: string[];
};

function SaveButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-sm"
    >
      {pending ? "Saving..." : "Save capture rules"}
    </button>
  );
}

/**
 * Capture Rules: which stage a captured lead starts in, and who it goes
 * to.
 *
 * WHAT IS DELIBERATELY NOT HERE — all four were specified as out of
 * scope for this pass, and none of them is a stub or a disabled
 * control, because a switch that does nothing is worse than an absent
 * one:
 *   Duplicate detection    the cross-platform AI merge-suggestion
 *                          feature, parked for a later phase. Retry
 *                          dedupe by UNIQUE_QUERY_ID is handled in the
 *                          database and needs no setting.
 *   Auto-tag by campaign   IndiaMART's payload has no campaign field.
 *   Instant notification   there is no notification system in this
 *                          codebase to hang it off (verified: no
 *                          notification module, table or provider
 *                          exists anywhere).
 *
 * The mode switch is a SelectField rather than a toggle: the two
 * branches show different controls underneath, and a select names both
 * options at once where a toggle only names the one you are not on.
 * It also means no new switch component — this app has no toggle
 * primitive today.
 */
export function CaptureSettingsForm({
  integrationId,
  stages,
  assignableUsers,
  defaultStageId,
  assignmentMode,
  defaultOwnerId,
  participantIds,
}: CaptureSettingsFormProps) {
  const [state, formAction] = useActionState(updateIntegrationSettingsAction, initialIntegrationFormState);
  const [mode, setMode] = useState<AssignmentMode>(assignmentMode);
  const fieldErrors = state.fieldErrors ?? {};

  // Only Active stages can hold a lead — protect_lead_stage_transition
  // rejects an inactive one on insert. The currently-saved stage is
  // kept selectable even if it has since been deactivated, so opening
  // this form does not silently change the saved value; the label says
  // why, and the webhook falls back on its own regardless.
  const selectableStages = stages.filter(
    (stage) => stage.status === "Active" || stage.id === defaultStageId,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="integration_id" value={integrationId} />

      <FormSection icon={<PipelineIcon className="h-3.5 w-3.5" />} title="Where new leads land">
        <SelectField
          label="Default stage"
          id="capture-default-stage"
          name="default_stage_id"
          defaultValue={defaultStageId ?? ""}
          error={fieldErrors.default_stage_id}
          helperText="Captured leads start here. If left unset — or if this stage is ever deactivated — the first active stage in your pipeline is used instead."
        >
          <option value="">Use the first stage in my pipeline</option>
          {selectableStages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.stage}
              {stage.status === "Inactive" ? " (Inactive)" : ""}
            </option>
          ))}
        </SelectField>
      </FormSection>

      <FormSection icon={<UserPlusIcon className="h-3.5 w-3.5" />} title="Who they go to">
        <SelectField
          label="Assignment"
          id="capture-assignment-mode"
          name="assignment_mode"
          required
          value={mode}
          onChange={(event) => setMode(event.target.value as AssignmentMode)}
          error={fieldErrors.assignment_mode}
        >
          <option value="Fixed">Fixed — always the same person</option>
          <option value="RoundRobin">Round-robin — rotate through a list</option>
        </SelectField>

        {/* BOTH controls stay mounted, and that is on purpose. Unmounting
            the hidden one would drop its value from FormData, so
            switching Fixed -> Round-robin -> Save would silently clear
            the Fixed owner the admin had already chosen. Hidden with
            `hidden` (not display:none via a class) so the browser still
            submits the inputs inside. */}
        <div hidden={mode !== "Fixed"}>
          <TeamSelect
            id="capture-default-owner"
            name="default_owner_id"
            label="Assign every lead to"
            options={assignableUsers}
            defaultSelectedIds={defaultOwnerId ? [defaultOwnerId] : []}
            emptyOptionLabel="Leave unassigned"
            error={fieldErrors.default_owner_id}
            helperText="Only active members of your organization are listed. Leave unassigned and captured leads will wait in the pipeline for someone to pick up."
          />
        </div>

        <div hidden={mode !== "RoundRobin"}>
          <TeamSelect
            id="capture-participants"
            name="participants"
            label="Rotate through"
            multiple
            options={assignableUsers}
            defaultSelectedIds={participantIds}
            error={fieldErrors.participants}
            /* Says outright that this is not "everyone", because that is
               the assumption a round-robin setting invites. */
            helperText="Add people explicitly — this list starts empty and never includes your whole team automatically. Leads are handed out in the order shown. If the list is empty, captured leads are left unassigned."
          />
        </div>
      </FormSection>

      {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}
      {state.success && state.message ? <MessageBanner tone="success">{state.message}</MessageBanner> : null}

      <div className="flex justify-end">
        <SaveButton />
      </div>
    </form>
  );
}
