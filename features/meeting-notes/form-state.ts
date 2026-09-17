/** Same shape every other form in this app uses (see CustomerFormState /
 *  InvitationFormState), plus what this one has to report back.
 *
 *  WHAT DELIBERATELY IS NOT HERE: the extraction itself. Phase 1's
 *  version returned the model's text straight to the browser; now the
 *  extraction is PERSISTED and the page re-reads it from the database,
 *  so the only thing that needs to cross back is "it worked, and here is
 *  which note to look at". That keeps one source of truth for what a
 *  note contains (the tables) rather than two (the tables and whatever
 *  the action happened to hand the client). */
export type MeetingNotesFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
  /** The note just created, so the UI can scroll to / highlight it. */
  meetingNoteId?: string;
  /** Zero is a real, successful outcome — the source was not meeting
   *  notes, per the extraction prompt's own rule. The UI says "No action
   *  items found", which must never be confused with a failure. */
  actionItemCount?: number;
  /** Which fallback tier produced this (1-based). Shown only when it is
   *  not tier 1, so a degraded provider is visible rather than silent. */
  tier?: number;
  /** Echoed back so the textarea keeps what the user typed after a
   *  failed submit — a Server Action response replaces the render, and
   *  an uncontrolled textarea would otherwise come back empty. Never
   *  echoed for an image: there is nothing to restore into a file
   *  input, and browsers will not accept one programmatically. */
  notes?: string;
};

export const initialMeetingNotesFormState: MeetingNotesFormState = {};
