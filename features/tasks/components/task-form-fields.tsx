"use client";

import { useMemo } from "react";
import { useFormStatus } from "react-dom";
import { FormField } from "@/components/shared/form-field";
import { SelectField } from "@/components/shared/select-field";
import { FormSection } from "@/components/shared/form-section";
// Reused directly from features/leads — the spec is explicit that Tasks
// must reuse the existing team-directory/name-resolution logic rather
// than build a second lookup, and this is that logic. Not promoted to a
// shared location: doing so would be a larger, unrequested refactor of
// where "team directory" utilities live (they predate Tasks and were
// only ever needed by Leads until now) — a light cross-feature import
// is the smaller, lower-risk move for a first version.
import { getOwnerDisplayLabels } from "@/features/leads/lib/owner-display";
import { TasksIcon, ClockIcon, UserPlusIcon } from "@/features/sales-management/components/icons";
import { TASK_PRIORITIES, TASK_TYPES } from "@/types/task";
import type { Lead, TeamDirectoryEntry } from "@/types/lead";

/** Shared submit button — same look as LeadFormSubmitButton/AddItemButton
 *  elsewhere in this app. */
export function TaskFormSubmitButton({ idleLabel, pendingLabel }: { idleLabel: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-sm"
    >
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}

type TaskFormFieldsProps = {
  /** Every Lead the caller can currently see (RLS-scoped already, same
   *  array the Pipeline page fetches) — a task can only ever be attached
   *  to one of these, matching "do not expose another customer's/
   *  branch's leads in the selector." */
  leads: Lead[];
  /** The caller's own hierarchy-visible teammates
   *  (getVisibleTeamDirectory) — ADMIN gets everyone in the customer,
   *  everyone else gets themselves + their recursive reports. The same
   *  list is used for every role; a SALES_REP naturally sees only
   *  themselves here (they have no reports), so "Assign defaults to and
   *  is effectively locked to self" falls out of this list being
   *  short, not a separate read-only branch in this component. */
  assignableUsers: TeamDirectoryEntry[];
  /** Preselects Assign to the current user on a brand-new task — still
   *  changeable by anyone whose assignableUsers list has more than one
   *  entry. */
  currentUserCustomerUserId: string;
  fieldErrors: Record<string, string>;
  /** Set when opened from a Lead's own "Add Task" action — preselects
   *  the Lead field (still changeable) rather than requiring it be
   *  picked again. */
  defaultLeadId?: string;
};

export function TaskFormFields({
  leads,
  assignableUsers,
  currentUserCustomerUserId,
  fieldErrors,
  defaultLeadId,
}: TaskFormFieldsProps) {
  // Same disambiguation logic the Owner column/picker use for Leads —
  // computed here from the raw assignableUsers array for the same
  // reason lead-form-fields.tsx does: this component only ever receives
  // the raw list, not something upstream that already derived labels.
  const assigneeLabelById = useMemo(() => getOwnerDisplayLabels(assignableUsers), [assignableUsers]);

  return (
    <>
      <FormSection icon={<TasksIcon className="h-3.5 w-3.5" />} title="Task details">
        <FormField
          label="Subject"
          name="subject"
          required
          variant="filled"
          placeholder="e.g. Call customer regarding proposal"
          error={fieldErrors.subject}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="task-description" className="text-sm font-medium text-neutral-700">
            Description
          </label>
          <textarea
            id="task-description"
            name="description"
            rows={3}
            placeholder="Optional details a teammate would find useful"
            aria-invalid={Boolean(fieldErrors.description)}
            className={`w-full resize-none rounded-lg border bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 ${
              fieldErrors.description ? "border-red-400" : "border-transparent"
            }`}
          />
          {fieldErrors.description ? (
            <p role="alert" className="text-xs text-red-600">
              {fieldErrors.description}
            </p>
          ) : null}
        </div>

        <SelectField
          label="Lead"
          id="task-lead"
          name="lead_id"
          required
          defaultValue={defaultLeadId ?? ""}
          error={fieldErrors.lead_id}
        >
          <option value="" disabled>
            Select a lead
          </option>
          {leads.map((lead) => (
            <option key={lead.id} value={lead.id}>
              {lead.company ? `${lead.company} — ${lead.contact_name}` : lead.contact_name}
            </option>
          ))}
        </SelectField>

        <SelectField label="Type" id="task-type" name="type" required defaultValue="Other" error={fieldErrors.type}>
          {TASK_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </SelectField>
      </FormSection>

      <FormSection icon={<ClockIcon className="h-3.5 w-3.5" />} title="Scheduling">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Due Date"
            name="due_date"
            type="date"
            required
            variant="filled"
            error={fieldErrors.due_date}
          />

          <SelectField
            label="Priority"
            id="task-priority"
            name="priority"
            required
            defaultValue="Medium"
            error={fieldErrors.priority}
          >
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </SelectField>
        </div>
      </FormSection>

      <FormSection icon={<UserPlusIcon className="h-3.5 w-3.5" />} title="Assignment">
        <SelectField
          label="Assign"
          id="task-assigned-to"
          name="assigned_to"
          required
          defaultValue={currentUserCustomerUserId}
          error={fieldErrors.assigned_to}
          helperText="Only teammates within your reporting hierarchy are listed."
        >
          {assignableUsers.map((assignee) => (
            <option key={assignee.customer_user_id} value={assignee.customer_user_id}>
              {assigneeLabelById.get(assignee.customer_user_id) ?? assignee.email} — {assignee.role_name}
            </option>
          ))}
        </SelectField>
      </FormSection>
    </>
  );
}
