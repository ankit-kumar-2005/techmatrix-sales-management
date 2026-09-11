export type ContactFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
};

export const initialContactFormState: ContactFormState = {};
