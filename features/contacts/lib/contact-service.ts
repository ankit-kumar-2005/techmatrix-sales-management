import type { SupabaseClient } from "@supabase/supabase-js";
import type { DomainActor, DomainWriteResult } from "@/types/customer";
import type { CreateContactInput, UpdateContactInput } from "../schemas";

/**
 * THE ONE BUSINESS-LOGIC PATH FOR CREATING AND EDITING A CONTACT.
 *
 * Moved line for line out of createContactAction/updateContactAction
 * (features/contacts/actions.ts), shared with the MCP create_contact/
 * update_contact tools. Same split as lead-service.ts.
 *
 * OWNER: a SALES_REP is forced to their own customer_users.id whatever was
 * submitted (defense in depth); everyone else's owner passes through and
 * RLS's is_customer_user_visible(owner_id) — on INSERT, and on both USING
 * and WITH CHECK for UPDATE — is the real judge.
 */

function resolveOwner(actor: DomainActor, submittedOwnerId: string): string {
  return actor.role === "SALES_REP" ? actor.customerUserId : submittedOwnerId;
}

/**
 * RETURNING id: added so the MCP tool can report what it created. It
 * cannot turn a success into a failure — the contacts INSERT policy
 * requires is_customer_user_visible(owner_id), the identical predicate
 * the SELECT policy uses, so any row the caller may insert they may read.
 */
export async function createContact(
  supabase: SupabaseClient,
  actor: DomainActor,
  input: CreateContactInput,
): Promise<DomainWriteResult> {
  const { data: created, error } = await supabase
    .from("contacts")
    .insert({
      customer_id: actor.customerId,
      lead_id: input.lead_id,
      owner_id: resolveOwner(actor, input.owner_id),
      name: input.name,
      company: input.company ?? null,
      title: input.title ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      tags: input.tags,
      created_by: actor.userId,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      kind: "failed",
      message: "Unable to create this contact. The lead or owner may not be available to you.",
    };
  }

  return { ok: true, id: (created?.id as string | undefined) ?? null };
}

export async function updateContact(
  supabase: SupabaseClient,
  actor: DomainActor,
  input: UpdateContactInput,
): Promise<DomainWriteResult> {
  const { data: updated, error } = await supabase
    .from("contacts")
    .update({
      owner_id: resolveOwner(actor, input.owner_id),
      name: input.name,
      company: input.company ?? null,
      title: input.title ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      tags: input.tags,
    })
    .eq("id", input.id)
    .eq("customer_id", actor.customerId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, kind: "failed", message: "Unable to update this contact. The owner may not be available to you." };
  }
  if (!updated) {
    return {
      ok: false,
      kind: "not_found",
      message: "This contact could not be updated. It may no longer be available to you.",
    };
  }

  return { ok: true, id: updated.id as string };
}
