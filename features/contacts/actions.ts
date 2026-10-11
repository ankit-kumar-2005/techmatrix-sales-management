"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import {
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { toDomainActor, toFormState } from "@/features/customers/lib/domain-actor";
import { createContactSchema, updateContactSchema } from "./schemas";
import { createContact, updateContact } from "./lib/contact-service";
import {
  getContactsPage,
  getDuplicateCandidates,
  getDismissedDuplicatePairs,
  type ContactsPage,
  type ContactsPageParams,
} from "./lib/get-contacts";
import { findPossibleDuplicates, type DuplicatePair } from "./lib/duplicate-detection";
import type { ContactFormState } from "./form-state";

/**
 * customer_id and created_by are never read from the form — customer_id
 * is always derived from the caller's own current membership, created_by
 * from the caller's own auth user id, matching every other
 * customer-scoped write in this app (see multi-tenant-security skill /
 * CLAUDE.md Section G).
 *
 * AUTHORIZATION: every role may create a contact (per spec), attached to
 * any Lead in their own customer (lead_id carries no caller-visibility
 * gate — see the contacts migration's design notes on why a Contact's
 * owner and its Lead's owner are independent), but the owner they assign
 * it to must be within their own visible hierarchy —
 * is_customer_user_visible(owner_id) is what actually enforces this (the
 * contacts INSERT policy re-checks the identical predicate regardless of
 * what this action does). SALES_REP is force-overridden to their own id
 * here as an explicit defense-in-depth measure (the same "never trust a
 * restricted role's submitted assignment" pattern createLeadAction uses
 * for owner_id) — everyone else's submitted owner_id is trusted through
 * to the INSERT and RLS is the real judge of whether it's actually
 * within their hierarchy.
 */
export async function createContactAction(_prevState: ContactFormState, formData: FormData): Promise<ContactFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const parsed = createContactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  // SALES_REP owner forcing and the insert live in the shared domain
  // service (also used by the MCP create_contact tool) — see
  // features/contacts/lib/contact-service.ts.
  const result = await createContact(supabase, toDomainActor(user.id, membership), parsed.data);
  if (!result.ok) {
    return toFormState(result);
  }

  revalidatePath("/contacts");
  return { success: true };
}

/**
 * lead_id is never read from the form (see updateContactSchema's own
 * comment) — it's immutable, enforced independently by
 * contacts_protect_identity_columns regardless of what this action does.
 *
 * AUTHORIZATION: identical shape to createContactAction's owner handling
 * — SALES_REP is force-overridden to their own id, everyone else's
 * submitted owner_id passes through to the UPDATE, and RLS's "visible-
 * hierarchy members can update a contact" policy (is_customer_user_
 * visible(owner_id) on both USING and WITH CHECK) is the real boundary:
 * it independently re-verifies both that the caller may currently see/
 * update THIS contact (its EXISTING owner_id) and that whoever they're
 * reassigning it to is within their own visible hierarchy. This action
 * does not duplicate either check in application code first — an
 * unauthorized update simply matches zero rows (caught below via
 * `.select("id").maybeSingle()` returning null) or fails outright,
 * exactly like every other role-hierarchy-gated write in this app.
 */
export async function updateContactAction(_prevState: ContactFormState, formData: FormData): Promise<ContactFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const parsed = updateContactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  // Shared with the MCP update_contact tool — features/contacts/lib/contact-service.ts.
  const result = await updateContact(supabase, toDomainActor(user.id, membership), parsed.data);
  if (!result.ok) {
    return toFormState(result);
  }

  revalidatePath("/contacts");
  return { success: true };
}

/**
 * Callable directly from ContactList (a Client Component) like an RPC,
 * the same way getTasksBucketPageAction/getCatalogItemsPageAction already
 * are — this project has no Route Handlers yet, and this is a read, not
 * a mutation, but Server Actions work equally well for either. customer_id
 * is never accepted as a parameter — always derived from the caller's own
 * current membership, same rule every other customer-scoped query in this
 * app follows.
 */
export async function getContactsPageAction(params: ContactsPageParams): Promise<ContactsPage> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  return getContactsPage(supabase, membership.customer.id, params);
}

/**
 * Runs duplicate detection against a bounded, customer-scoped candidate
 * set (getDuplicateCandidates) and filters out anything already dismissed
 * (contact_duplicate_dismissals, also customer-scoped by its own RLS) —
 * both queries are already tenant-isolated before findPossibleDuplicates
 * (a pure function with no database/tenancy awareness of its own) ever
 * sees the data, so it's structurally impossible for another customer's
 * contacts to reach the Fuse.js index this call feeds.
 */
export async function getPossibleDuplicatesAction(): Promise<DuplicatePair[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const [candidates, dismissedPairs] = await Promise.all([
    getDuplicateCandidates(supabase, membership.customer.id),
    getDismissedDuplicatePairs(supabase, membership.customer.id),
  ]);

  return findPossibleDuplicates(candidates, dismissedPairs);
}

export type DismissDuplicateResult = { success: boolean; error?: string };

/**
 * Persists "Not a duplicate" so re-running detection never resurfaces
 * this exact pair again — canonically ordered the same way
 * duplicate-detection.ts orders a pair (`.sort()` on the two UUID
 * strings, which matches Postgres's own uuid `<` ordering for lowercase
 * hyphenated UUID text), satisfying the migration's
 * contact_duplicate_dismissals_ordered_pair CHECK regardless of which of
 * the two contacts the caller clicked "Not a duplicate" from. RLS's
 * "members can dismiss duplicate contact pairs for their customer"
 * policy (is_customer_member(customer_id) + the composite same-customer
 * FKs on both contact_id_a/contact_id_b) is what actually enforces that
 * both contacts belong to this caller's own customer — this action does
 * not re-check that separately first.
 */
export async function dismissDuplicateAction(contactIdA: string, contactIdB: string): Promise<DismissDuplicateResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const [idA, idB] = [contactIdA, contactIdB].sort();

  const { error } = await supabase.from("contact_duplicate_dismissals").insert({
    customer_id: membership.customer.id,
    contact_id_a: idA,
    contact_id_b: idB,
    dismissed_by: user.id,
  });

  if (error) {
    // 23505 = unique_violation — this exact pair was already dismissed
    // (e.g. a double click, or dismissed from another tab) — treat that
    // as success, not an error, since the end state the user wanted
    // ("this pair is dismissed") already holds.
    if (error.code === "23505") {
      return { success: true };
    }
    return { success: false, error: "Unable to dismiss this pair. Please try again." };
  }

  return { success: true };
}
