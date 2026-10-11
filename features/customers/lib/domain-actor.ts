import type { CurrentMembership, DomainActor, DomainWriteResult } from "@/types/customer";

/** Builds the acting person for a domain service from a VERIFIED user id
 *  and the live membership row (getCurrentMembership). Never from input. */
export function toDomainActor(userId: string, membership: CurrentMembership): DomainActor {
  return {
    userId,
    customerId: membership.customer.id,
    customerUserId: membership.membership.id,
    role: membership.role,
  };
}

/** A domain result as the form state every Lead/Task/Contact Server
 *  Action has always returned: field errors, a form-level message, or
 *  success. Messages pass through unchanged. */
export function toFormState(result: DomainWriteResult): {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
} {
  if (result.ok) return { success: true };
  if (result.kind === "invalid") return { fieldErrors: result.fieldErrors };
  return { formError: result.message };
}
