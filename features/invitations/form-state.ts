/** Same shape every other form in this app uses (see
 *  CustomerFormState/ContactFormState), plus one extra signal.
 *
 *  `alreadyPending` marks the one "failure" that isn't really a failure:
 *  a PENDING invitation for that email already exists, so the right next
 *  action is Resend, not Create. It is returned alongside formError (so
 *  a caller that ignores it still shows a sensible message) and carries
 *  the existing invitation's id so the UI can offer Resend directly
 *  without looking it up again. */
export type InvitationFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
  alreadyPending?: { invitationId: string };
};

export const initialInvitationFormState: InvitationFormState = {};

/** Non-form actions (resend/cancel/accept) return this instead — the
 *  same { success, error } result shape setCatalogItemStatusAction and
 *  moveLeadStageAction already use for dialog/row-level actions.
 *  `retryAfterSeconds` is set only by the resend cooldown, so the UI can
 *  show an accurate countdown instead of guessing. */
export type InvitationActionResult = {
  success: boolean;
  error?: string;
  retryAfterSeconds?: number;
};
