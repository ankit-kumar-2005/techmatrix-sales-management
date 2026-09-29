"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { AutomationsIcon } from "@/features/sales-management/components/icons";
import { extractLeadAction } from "../actions";
import { initialLeadExtractionFormState } from "../form-state";
import { LEAD_EXTRACTION_MAX_LENGTH } from "../schemas";
import type { LeadFormDefaultValues } from "./lead-form-fields";

type AiLeadCreationEntryProps = {
  /** Handed a READY extraction's fields, already shaped as
   *  LeadFormDefaultValues — the caller (LeadCreationControls) passes
   *  this straight to CreateLeadDialog's own aiPrefill prop, which is
   *  what actually opens the real New Lead form. This component never
   *  opens a form of its own. */
  onReady: (values: LeadFormDefaultValues) => void;
};

function AnalyzeButton({ hasQuestions }: { hasQuestions: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Analyzing..." : hasQuestions ? "Continue" : "Extract details"}
    </button>
  );
}

/** Same reasoning as Meeting Notes' own PendingHint: a disabled button
 *  alone reads as a frozen page on a free-tier model that can take up
 *  to a minute. */
function PendingHint() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <p role="status" className="text-xs leading-relaxed text-neutral-500">
      Reading the text and extracting a lead. This runs on a free AI model and can take up to a minute — if the
      first one is busy, it falls back to another automatically.
    </p>
  );
}

/**
 * "Create with AI" — the second door next to the existing "New Lead"
 * button, opening a small paste-a-transcript panel instead of a second
 * copy of the lead form.
 *
 * THIS COMPONENT NEVER CREATES A LEAD. It calls extractLeadAction,
 * which itself never writes to `leads` (see extract-lead.ts's own
 * header) — a READY result is handed to the caller via onReady and
 * this panel closes; the caller opens the EXISTING CreateLeadDialog
 * pre-filled with it, where a human reviews and explicitly saves
 * through the exact same createLeadAction a manual entry uses.
 */
export function AiLeadCreationEntry({ onReady }: AiLeadCreationEntryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, formAction] = useActionState(extractLeadAction, initialLeadExtractionFormState);
  const [transcript, setTranscript] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const result = state.result;
  const questions = result?.status === "NEEDS_CLARIFICATION" ? result.questions : [];

  // Combined into one hidden field rather than one form field per
  // question, so the server side only ever has to read a single,
  // already-labeled block of text — see extractLeadAction/extractLead's
  // own "Additional context" framing. Recomputed on every render from
  // the live `answers` state, so it is always in sync with what's on
  // screen at the moment Continue is actually clicked.
  const clarificationContext = questions
    .map((question) => `Q: ${question}\nA: ${(answers[question] ?? "").trim() || "(not answered)"}`)
    .join("\n\n");

  // Once a READY result comes back: hand the fields to the caller
  // (which opens the real New Lead form pre-filled), close this panel,
  // and reset it so the next open starts clean.
  //
  // A REAL useEffect, NOT the render-time "compare to last-handled
  // state" idiom CreateLeadDialog itself uses for its own success-close
  // logic — that idiom is only safe for adjusting a component's OWN
  // state during render. onReady() is the PARENT's setState
  // (LeadCreationControls' setAiPrefill), and calling another
  // component's setter mid-render is exactly what produced this
  // component's own bug report: "Cannot update a component
  // (LeadCreationControls) while rendering a different component
  // (AiLeadCreationEntry)." Notifying a different component is a
  // genuine side effect, which is what useEffect is for.
  useEffect(() => {
    if (state.result?.status !== "READY") return;
    const lead = state.result.lead;
    onReady({
      // LeadFormDefaultValues.contact_name is a plain `string`, never
      // `| null` — everything else on it already accepts `| null`
      // directly (see that type's own field-by-field declaration).
      contact_name: lead.contact_name ?? undefined,
      company: lead.company,
      email: lead.email,
      phone: lead.phone,
      deal_value: lead.deal_value,
      source: lead.source,
      next_step: lead.next_step,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting this panel's own local UI state in direct response to a Server Action result that just arrived (not something derivable during render), the same category AppShell's own mount-time sync effect is exempted for
    setIsOpen(false);
    setTranscript("");
    setAnswers({});
    // onReady is expected to be a stable setState setter (see
    // LeadCreationControls) — only a genuinely new `state` from
    // useActionState should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex min-h-11 items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-5 py-2.5 text-sm font-semibold text-violet-700 transition-all duration-200 hover:border-violet-300 hover:bg-violet-100 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <AutomationsIcon className="h-4 w-4 shrink-0" />
        Create with AI
      </button>

      {isOpen ? (
        <Modal
          title="Create Lead with AI"
          subtitle="Paste a call transcript or email — we'll pre-fill the New Lead form for you to review."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-sm shadow-blue-600/20">
              <AutomationsIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setIsOpen(false)}
        >
          <form action={formAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="lead-transcript" className="text-sm font-medium text-neutral-700">
                Call transcript or email
              </label>
              <textarea
                id="lead-transcript"
                name="transcript"
                rows={8}
                maxLength={LEAD_EXTRACTION_MAX_LENGTH}
                placeholder="Paste it here. For example: Spoke with Priya Sharma at Northwind Interiors about the enterprise plan, budget around 2,00,000. She'd like a proposal by Friday. Her number is 98765 43210."
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                aria-invalid={Boolean(state.fieldErrors?.transcript)}
                className={`w-full resize-y rounded-lg border bg-neutral-100 px-3.5 py-2.5 text-sm leading-relaxed text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 ${
                  state.fieldErrors?.transcript ? "border-red-400" : "border-transparent hover:border-neutral-300"
                }`}
              />
              {state.fieldErrors?.transcript ? (
                <p role="alert" className="text-xs text-red-600">
                  {state.fieldErrors.transcript}
                </p>
              ) : null}
            </div>

            <input type="hidden" name="clarification_context" value={clarificationContext} />

            {questions.length > 0 ? (
              <div className="flex flex-col gap-3 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-100">
                <div>
                  <p className="text-xs font-bold tracking-wide text-amber-800 uppercase">
                    {questions.length === 1 ? "One thing to confirm" : "A couple of things to confirm"}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-amber-900">
                    Rather than guess, here is what&rsquo;s still unclear — answer below and continue.
                  </p>
                </div>
                {questions.map((question) => (
                  <div key={question} className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-amber-900">{question}</label>
                    <input
                      type="text"
                      value={answers[question] ?? ""}
                      onChange={(event) => setAnswers((current) => ({ ...current, [question]: event.target.value }))}
                      className="w-full rounded-lg border border-amber-200 bg-white px-3.5 py-2 text-sm text-neutral-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

            <AnalyzeButton hasQuestions={questions.length > 0} />
            <PendingHint />
          </form>
        </Modal>
      ) : null}
    </>
  );
}
