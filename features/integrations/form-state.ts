/** Same shape as every other form state in this app
 *  (CatalogItemFormState / TaskFormState / InvitationFormState), so the
 *  dialogs and inline error renderers behave identically. */
export type IntegrationFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
  /** Set after a successful save so the panel can show a short
   *  confirmation without needing its own local success state. */
  message?: string;
};

export const initialIntegrationFormState: IntegrationFormState = {};
