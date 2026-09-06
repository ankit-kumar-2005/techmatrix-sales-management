export type LeadFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
};

export const initialLeadFormState: LeadFormState = {};
