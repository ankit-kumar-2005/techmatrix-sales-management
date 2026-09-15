"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Modal } from "@/components/shared/modal";
import { FormField } from "@/components/shared/form-field";
import { MessageBanner } from "@/components/shared/message-banner";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
} from "@/features/sales-management/components/icons";
import {
  createLeadStageAction,
  reorderLeadStageAction,
  setLeadStageStatusAction,
  updateLeadStageAction,
} from "../actions";
import { initialLeadStageFormState } from "../stage-form-state";
import { stageBadgeClasses } from "../lib/stage-colors";
import type { CustomerLeadStage } from "@/types/lead";

type LeadStageSettingsProps = {
  stages: CustomerLeadStage[];
  /** ADMIN *role* — a different concept from Company Information's own
   *  "Primary Admin" (customers.created_by) gate. Every ADMIN-role user
   *  can configure stages; only the Primary Admin can edit the rest of
   *  Company Information's fields. RLS (is_customer_admin, role-based)
   *  is the real boundary regardless of this prop. */
  canConfigure: boolean;
};

export function LeadStageSettings({ stages, canConfigure }: LeadStageSettingsProps) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<CustomerLeadStage | null>(null);

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xs font-semibold tracking-wider text-neutral-500 uppercase">Lead Stages</h2>
          <p className="mt-1.5 text-sm text-neutral-500">Configure the sales stages used by your company.</p>
        </div>
        {canConfigure ? (
          <button
            type="button"
            onClick={() => setIsAddOpen(true)}
            className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-sky-700 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
          >
            <PlusIcon className="h-4 w-4" />
            Add Stage
          </button>
        ) : null}
      </div>

      <ul className="mt-5 flex flex-col gap-2">
        {stages.map((stage, index) => (
          <StageRow
            key={stage.id}
            stage={stage}
            canConfigure={canConfigure}
            isFirst={index === 0}
            isLast={index === stages.length - 1}
            onEdit={() => setEditingStage(stage)}
          />
        ))}
      </ul>

      {isAddOpen ? <StageDialog title="Add Stage" onClose={() => setIsAddOpen(false)} /> : null}
      {editingStage ? (
        <StageDialog title="Edit Stage" stage={editingStage} onClose={() => setEditingStage(null)} />
      ) : null}
    </div>
  );
}

type StageRowProps = {
  stage: CustomerLeadStage;
  canConfigure: boolean;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
};

function StageRow({ stage, canConfigure, isFirst, isLast, onEdit }: StageRowProps) {
  const [isPending, startTransition] = useTransition();

  function move(direction: "up" | "down") {
    startTransition(async () => {
      await reorderLeadStageAction(stage.id, direction);
    });
  }

  function toggleStatus() {
    const nextStatus = stage.status === "Active" ? "Inactive" : "Active";
    if (nextStatus === "Inactive") {
      const confirmed = window.confirm(
        `Deactivate "${stage.stage}"? It will no longer be selectable for new leads. Existing leads already in this stage keep it and remain unaffected.`,
      );
      if (!confirmed) return;
    }
    startTransition(async () => {
      await setLeadStageStatusAction(stage.id, nextStatus);
    });
  }

  return (
    <li
      className={`flex flex-wrap items-center gap-3 rounded-xl border border-neutral-100 px-4 py-3 transition-opacity ${
        isPending ? "opacity-60" : ""
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${stageBadgeClasses(stage)}`}>
          {stage.is_closed ? <LockIcon className="h-2.5 w-2.5" /> : null}
          {stage.stage}
        </span>
        {stage.status === "Inactive" ? (
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-neutral-500 uppercase">
            Inactive
          </span>
        ) : null}
        {stage.is_closed ? (
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-neutral-500 uppercase">
            {stage.is_won ? "Closed · Won" : "Closed"}
          </span>
        ) : null}
        {/* Only meaningful for an open stage — a closed one's probability
            is derived (won = 100%, everything else 0%) and showing it
            here would read as a setting rather than a consequence. A 0%
            open stage is called out in amber because it contributes
            nothing to the forecast, which is almost always an oversight
            rather than a decision. */}
        {!stage.is_closed ? (
          <span
            title="Probability used to weight this stage in the revenue forecast"
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
              stage.probability === 0 ? "bg-amber-50 text-amber-700" : "bg-neutral-100 text-neutral-500"
            }`}
          >
            {stage.probability}% likely
          </span>
        ) : null}
      </div>

      {canConfigure ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => move("up")}
            disabled={isFirst || isPending}
            aria-label={`Move ${stage.stage} up`}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronUpIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => move("down")}
            disabled={isLast || isPending}
            aria-label={`Move ${stage.stage} down`}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronDownIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${stage.stage}`}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleStatus}
            disabled={isPending}
            className="ml-1 min-h-8 rounded-full border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stage.status === "Active" ? "Deactivate" : "Activate"}
          </button>
        </div>
      ) : null}
    </li>
  );
}

type StageDialogProps = {
  title: string;
  stage?: CustomerLeadStage;
  onClose: () => void;
};

function StageDialog({ title, stage, onClose }: StageDialogProps) {
  const action = stage ? updateLeadStageAction : createLeadStageAction;
  const [state, formAction] = useActionState(action, initialLeadStageFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Controlled (not defaultChecked) because the three outcome fields are
  // interdependent: "counts as won" is only meaningful for a closed
  // stage, and a closed stage's probability is fully determined by
  // whether it's a win. Driving all three from state is what makes the
  // combination the database rejects (is_won without is_closed)
  // unreachable from this form — resolveStageOutcome in actions.ts still
  // guards it server-side, because a form is never the boundary.
  const [isClosed, setIsClosed] = useState(stage?.is_closed ?? false);
  const [isWon, setIsWon] = useState(stage?.is_won ?? false);
  // Blank for a new stage on purpose — the schema requires a value, so
  // adding a stage is a deliberate choice about what it contributes to
  // the forecast rather than a silent inherit of the column's 0 default.
  const [probability, setProbability] = useState(stage ? String(stage.probability) : "");

  // What actually submits. readOnly rather than disabled for the closed
  // case: a disabled input submits NOTHING, which would trip the
  // schema's own "Probability is required" instead of sending the
  // derived value.
  const submittedProbability = isClosed ? (isWon ? "100" : "0") : probability;

  // Unchecking "closed" must also clear "won" — leaving it set would be
  // exactly the contradictory state the CHECK refuses.
  function handleClosedChange(nextIsClosed: boolean) {
    setIsClosed(nextIsClosed);
    if (!nextIsClosed) setIsWon(false);
  }

  // Same fix as EditLeadDialog: onClose here updates the PARENT's
  // (LeadStageSettings') isAddOpen/editingStage state, not this
  // component's own — that must be deferred to an effect, not called
  // synchronously during this component's render.
  useEffect(() => {
    if (state.success) {
      onClose();
    }
  }, [state, onClose]);

  return (
    <Modal title={title} onClose={onClose}>
      <form action={formAction} className="flex flex-col gap-4">
        {stage ? <input type="hidden" name="id" value={stage.id} /> : null}

        <FormField
          label="Stage Name"
          name="stage"
          required
          variant="filled"
          defaultValue={stage?.stage ?? ""}
          error={fieldErrors.stage}
          autoFocus
        />

        <FormField
          label="Win Probability (%)"
          name="probability"
          type="number"
          min="0"
          max="100"
          step="1"
          required
          variant="filled"
          value={submittedProbability}
          onChange={(event) => setProbability(event.target.value)}
          readOnly={isClosed}
          error={fieldErrors.probability}
          placeholder="e.g. 45"
          helperText={
            isClosed
              ? isWon
                ? "A won stage is always 100% — this deal already closed."
                : "A closed stage that isn't a win is always 0% — it will never close."
              : "Used to weight this stage in the revenue forecast."
          }
          className={isClosed ? "cursor-not-allowed" : ""}
        />

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              name="is_closed"
              checked={isClosed}
              onChange={(event) => handleClosedChange(event.target.checked)}
              className="h-4 w-4 rounded border-neutral-300 text-sky-600 focus:ring-2 focus:ring-sky-500/30"
            />
            Mark as closed stage
          </label>

          {/* Disabled (not hidden) when the stage is open: a disabled
              checkbox submits nothing, so is_won arrives as false, and
              keeping the row visible explains WHY it can't be set. */}
          <label
            className={`flex items-center gap-2 text-sm ${isClosed ? "text-neutral-700" : "text-neutral-400"}`}
          >
            <input
              type="checkbox"
              name="is_won"
              checked={isWon}
              disabled={!isClosed}
              onChange={(event) => setIsWon(event.target.checked)}
              className="h-4 w-4 rounded border-neutral-300 text-emerald-600 focus:ring-2 focus:ring-emerald-500/30 disabled:cursor-not-allowed"
            />
            This stage counts as won
          </label>

          <p className="text-xs text-neutral-500">
            {isClosed
              ? "Leads reaching a closed stage are locked. Won stages feed Closed-Won to Date and Win Rate; every other closed stage counts as lost."
              : "Only a closed stage can count as won."}
          </p>

          {fieldErrors.is_won ? (
            <p role="alert" className="text-xs font-medium text-red-600">
              {fieldErrors.is_won}
            </p>
          ) : null}
        </div>

        {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

        <div className="mt-2 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
          >
            Cancel
          </button>
          <SaveStageButton />
        </div>
      </form>
    </Modal>
  );
}

function SaveStageButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Saving..." : "Save Stage"}
    </button>
  );
}
