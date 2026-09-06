export type CustomerFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
};

export const initialCustomerFormState: CustomerFormState = {};
