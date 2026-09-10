export type TaskFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
};

export const initialTaskFormState: TaskFormState = {};
