export type CatalogItemFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
};

export const initialCatalogItemFormState: CatalogItemFormState = {};
