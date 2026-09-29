"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { LeadCaptureIcon } from "@/features/sales-management/components/icons";
import { createLeadAction } from "../actions";
import { initialLeadFormState } from "../form-state";
import { LeadFormFields, LeadFormSubmitButton, type LeadFormDefaultValues } from "./lead-form-fields";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

type CreateLeadDialogProps = {
  /** Every one of this customer's stages, ordered by display_order —
   *  LeadFormFields itself narrows this to Active-only here (a brand-new
   *  lead has no defaultValues.stage_id to keep an inactive one
   *  selectable), the same order used everywhere else (filter, board,
   *  legend). This is the entire dropdown; there is no fixed fallback
   *  list. */
  stages: CustomerLeadStage[];
  owners: TeamDirectoryEntry[];
  /** Only ADMIN gets an editable Owner picker — everyone else gets a
   *  read-only display of themselves, since createLeadAction forces
   *  owner_id to the caller's own id for every non-admin role. */
  role: CustomerRole;
  currentUserEmail: string;
  /** Renders the trigger element; receives a function that opens this
   *  dialog blank. The SAME "caller controls its own trigger" pattern
   *  AddTaskDialog/NewContactDialog already use, and for the identical
   *  reason: this dialog is mounted in TWO places — the Pipeline page's
   *  own LeadCreationControls (a real, visible "New Lead" button) and
   *  the AI assistant's globally-mounted launcher (renderTrigger={() =>
   *  null}, no visible button at all, only ever opened programmatically
   *  via aiPrefill below). Before this prop existed, this component
   *  hardcoded its own "New Lead" button directly in its JSX — which
   *  the assistant launcher's global mount then rendered on every page
   *  in the app, not just Pipeline, since there was no way to suppress
   *  it. */
  renderTrigger: (open: () => void) => ReactNode;
  /** Set by the AI-assisted creation flow (features/leads/components/
   *  ai-lead-creation.tsx, and the assistant's own create_lead intent)
   *  to open THIS SAME dialog pre-filled, instead of it building a
   *  second form. A new object (even one with identical values) opens
   *  the dialog again — see the effect below — which is why the caller
   *  is expected to hand over a fresh object each time it wants this to
   *  fire, not a mutated one. Undefined/null has no effect at all:
   *  renderTrigger's own trigger opening the dialog blank is unaffected
   *  either way. */
  aiPrefill?: LeadFormDefaultValues | null;
  /** Called once aiPrefill has been consumed (the dialog has opened
   *  with it), so the caller can clear its own state — otherwise the
   *  identical object would still be sitting there the next time this
   *  is checked, and a later, genuinely new extraction with
   *  by-coincidence-identical values wouldn't be distinguishable from
   *  "already handled." */
  onAiPrefillConsumed?: () => void;
};

/**
 * The one new piece of functionality this page gains: a real INSERT
 * into public.leads via createLeadAction, RLS + the composite
 * same-customer-safe owner/stage FKs enforcing tenant isolation
 * underneath. Mounted only while open, so each open starts from a clean,
 * empty form — including right after a successful create (see the
 * state-reset effect below).
 *
 * THE SAME DIALOG THE AI FLOW OPENS. aiPrefill is the only thing that
 * makes this open pre-filled rather than blank — everything else
 * (createLeadAction, every field's validation, Save) is completely
 * unaware of how the values it starts with got there. There is no
 * second "AI create" form anywhere in this codebase.
 */
export function CreateLeadDialog({
  stages,
  owners,
  role,
  currentUserEmail,
  renderTrigger,
  aiPrefill,
  onAiPrefillConsumed,
}: CreateLeadDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [defaultValues, setDefaultValues] = useState<LeadFormDefaultValues | undefined>(undefined);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [state, formAction] = useActionState(createLeadAction, initialLeadFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Opens THIS dialog, pre-filled, the moment the AI flow hands over a
  // freshly extracted draft. Render-time state adjustment (React's own
  // documented pattern for "a prop changed"), not useEffect — the exact
  // same idiom the success-close logic right below already uses, and
  // required here for the same reason: this project's React Compiler
  // lint rule treats setState-inside-an-effect as a hard error. Identity
  // comparison is deliberate — see aiPrefill's own doc comment above.
  //
  // ONLY THIS COMPONENT'S OWN STATE IS TOUCHED HERE. Calling
  // onAiPrefillConsumed() in this same block previously updated the
  // PARENT's state (LeadCreationControls' setAiPrefill) during THIS
  // component's render — the exact "Cannot update a component while
  // rendering a different component" error, caught live while testing
  // the click-through-and-submit flow. That notification now happens in
  // the separate useEffect below, which is the correct place for a
  // side effect that reaches outside this component.
  const [lastHandledAiPrefill, setLastHandledAiPrefill] = useState(aiPrefill);
  if (aiPrefill !== lastHandledAiPrefill) {
    setLastHandledAiPrefill(aiPrefill);
    if (aiPrefill) {
      setDefaultValues(aiPrefill);
      setIsOpen(true);
    }
  }

  // Tells the parent this aiPrefill has been consumed, so it clears its
  // own state — a real side effect (it updates a DIFFERENT component),
  // run after commit rather than during this component's render.
  useEffect(() => {
    if (aiPrefill) {
      onAiPrefillConsumed?.();
    }
    // Only aiPrefill's own identity should re-run this — see its doc
    // comment above for why identity (not a value comparison) is what
    // drives this whole mechanism.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPrefill]);

  // Close the dialog once a create succeeds. Comparing to a ref-like
  // state value (React's documented "adjust state during render"
  // pattern) instead of useEffect, matching CompanyInformationForm.
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

  return (
    <>
      {renderTrigger(() => {
        // A blank form every time this specific trigger opens the
        // dialog, even right after an AI-prefilled open — otherwise
        // stale extracted values could reappear the next time someone
        // deliberately asks for a plain new lead.
        setDefaultValues(undefined);
        setIsOpen(true);
      })}

      {isOpen ? (
        <Modal
          title="New Lead"
          subtitle={
            defaultValues
              ? "Pre-filled from the text you pasted — review, correct anything, and add what's missing."
              : "Add a new lead to your pipeline."
          }
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 ring-1 ring-sky-100">
              <LeadCaptureIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setIsOpen(false)}
        >
          <form action={formAction} className="flex flex-col gap-5">
            <LeadFormFields
              stages={stages}
              owners={owners}
              role={role}
              currentUserEmail={currentUserEmail}
              fieldErrors={fieldErrors}
              defaultValues={defaultValues}
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
              <LeadFormSubmitButton idleLabel="Add Lead" pendingLabel="Adding..." />
            </div>
          </form>
        </Modal>
      ) : null}

      {showSuccessToast ? (
        <div className="fixed right-6 bottom-6 z-[1100] w-full max-w-xs shadow-lg">
          <MessageBanner tone="success">Lead created successfully.</MessageBanner>
        </div>
      ) : null}
    </>
  );
}
