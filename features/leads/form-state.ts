import type { LeadExtractionResult } from "@/types/lead";

export type LeadFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
};

export const initialLeadFormState: LeadFormState = {};

/** Same shape as AiBuilderState (features/automations/form-state.ts) —
 *  the extraction result is handed straight back to the client, never
 *  persisted, because this feature has nothing to persist until a human
 *  submits the pre-filled New Lead form itself. */
export type LeadExtractionFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  result?: LeadExtractionResult;
  /** Echoed back so the textarea keeps what was pasted after a failed
   *  or clarification-needing submit — a Server Action response
   *  replaces the render, and an uncontrolled textarea would otherwise
   *  come back empty. Same reasoning as MeetingNotesFormState.notes. */
  transcript?: string;
};

export const initialLeadExtractionFormState: LeadExtractionFormState = {};
