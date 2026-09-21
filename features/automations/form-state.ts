import type { AiGenerationResult, ValidationIssue } from "@/types/automation";

/** Same shape as every other form state in this app
 *  (IntegrationFormState / TaskFormState / CatalogItemFormState), so the
 *  existing inline error renderers behave identically here. */
export type AutomationFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
  message?: string;
  /** Set when a save or an activation was refused by workflow
   *  validation, so the builder can point at the offending nodes rather
   *  than showing one flat sentence. */
  issues?: ValidationIssue[];
  /** Set by a successful first save so the builder can switch from
   *  "create" to "edit" without a round trip through the list page. */
  automationId?: string;
};

export const initialAutomationFormState: AutomationFormState = {};

export type AiBuilderState = {
  formError?: string;
  fieldErrors?: Record<string, string>;
  result?: AiGenerationResult;
};

export const initialAiBuilderState: AiBuilderState = {};
