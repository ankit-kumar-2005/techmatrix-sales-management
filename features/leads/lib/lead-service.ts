import type { SupabaseClient } from "@supabase/supabase-js";
import type { DomainActor, DomainWriteResult } from "@/types/customer";
import type { CreateLeadInput, UpdateLeadInput } from "../schemas";

/**
 * THE ONE BUSINESS-LOGIC PATH FOR CREATING AND EDITING A LEAD.
 *
 * Moved here, line for line, out of createLeadAction/updateLeadAction
 * (features/leads/actions.ts) so that two callers run the identical
 * rules: those Server Actions (cookie session) and the MCP server's
 * create_lead/update_lead tools (the user's own bearer token). Both pass
 * in a Supabase client that is ALREADY authenticated as the acting
 * person, so every query below runs under that person's RLS — this
 * module never constructs a client and never sees a service-role key.
 *
 * What stays with each caller, deliberately: authentication, resolving
 * the membership into a DomainActor, Zod parsing, revalidatePath() and
 * the automation drain nudge (after()) — all of which are Next.js
 * request concerns, and keeping them out is what makes this module
 * testable in isolation (features/leads/lib/lead-service.test.ts).
 *
 * Every rule below is still UX-layer first and database-enforced second,
 * exactly as before the move: the leads INSERT/UPDATE policies,
 * protect_lead_stage_transition and leads_protect_owner_id_change are
 * what hold if anything here were bypassed. See the original actions'
 * comments for the full reasoning behind each check — preserved there.
 */

async function checkStage(
  supabase: SupabaseClient,
  customerId: string,
  stageId: string,
): Promise<DomainWriteResult | null> {
  const { data: stage, error: stageError } = await supabase
    .from("customer_lead_stages")
    .select("id, status")
    .eq("id", stageId)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (stageError || !stage) {
    return { ok: false, kind: "invalid", fieldErrors: { stage_id: "Select a valid stage." } };
  }
  if (stage.status !== "Active") {
    return {
      ok: false,
      kind: "invalid",
      fieldErrors: { stage_id: "That stage is no longer active. Please choose another." },
    };
  }
  return null;
}

/**
 * OWNER: only an ADMIN may choose the owner; everyone else is forced to
 * their own customer_users.id, whatever was submitted. STAGE: must belong
 * to this customer and be Active at creation time. RETURNING id: added so
 * the MCP tool can report what it created — it cannot turn a success into
 * a failure, because the leads INSERT policy only admits a row the
 * caller can also SELECT (an admin sees every lead; anyone else may only
 * create a lead they own, which they always see).
 */
export async function createLead(
  supabase: SupabaseClient,
  actor: DomainActor,
  input: CreateLeadInput,
): Promise<DomainWriteResult> {
  const stageProblem = await checkStage(supabase, actor.customerId, input.stage_id);
  if (stageProblem) return stageProblem;

  const ownerId = actor.role === "ADMIN" ? (input.owner_id ?? null) : actor.customerUserId;

  // "same as contact number" is resolved authoritatively here, not
  // trusted from any client-side copy.
  const whatsappPhone = input.whatsapp_same ? input.phone : (input.whatsapp_phone ?? null);

  const { data: created, error } = await supabase
    .from("leads")
    .insert({
      customer_id: actor.customerId,
      company: input.company ?? null,
      contact_name: input.contact_name,
      email: input.email ?? null,
      phone: input.phone,
      whatsapp_phone: whatsappPhone,
      address: input.address ?? null,
      deal_value: input.deal_value ?? null,
      expected_close_date: input.expected_close_date ?? null,
      stage_id: input.stage_id,
      owner_id: ownerId,
      source: input.source ?? null,
      next_step: input.next_step ?? null,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, kind: "failed", message: "Something went wrong creating the lead. Please try again." };
  }

  return { ok: true, id: (created?.id as string | undefined) ?? null };
}

/**
 * CLOSED-LEAD LOCK, OWNERSHIP (ADMIN or the lead's own current owner —
 * hierarchy visibility does NOT grant edit), owner_id only ever written
 * by an ADMIN, and the Active-stage check only when stage_id changes.
 * A lead the caller cannot see comes back as "Lead not found." — the same
 * answer as one that does not exist.
 */
export async function updateLead(
  supabase: SupabaseClient,
  actor: DomainActor,
  input: UpdateLeadInput,
): Promise<DomainWriteResult> {
  const { data: existingLead, error: fetchError } = await supabase
    .from("leads")
    .select("id, owner_id, stage_id, closed_at")
    .eq("id", input.id)
    .eq("customer_id", actor.customerId)
    .maybeSingle();

  if (fetchError || !existingLead) {
    return { ok: false, kind: "not_found", message: "Lead not found." };
  }

  if (existingLead.closed_at) {
    return { ok: false, kind: "forbidden", message: "This lead is closed and cannot be edited." };
  }

  const isOwnLead = existingLead.owner_id === actor.customerUserId;
  if (actor.role !== "ADMIN" && !isOwnLead) {
    return { ok: false, kind: "forbidden", message: "You don't have permission to edit this lead." };
  }

  if (input.stage_id !== existingLead.stage_id) {
    const stageProblem = await checkStage(supabase, actor.customerId, input.stage_id);
    if (stageProblem) return stageProblem;
  }

  const whatsappPhone = input.whatsapp_same ? input.phone : (input.whatsapp_phone ?? null);

  const updatePayload: Record<string, unknown> = {
    company: input.company ?? null,
    contact_name: input.contact_name,
    email: input.email ?? null,
    phone: input.phone,
    whatsapp_phone: whatsappPhone,
    address: input.address ?? null,
    deal_value: input.deal_value ?? null,
    expected_close_date: input.expected_close_date ?? null,
    stage_id: input.stage_id,
    source: input.source ?? null,
    next_step: input.next_step ?? null,
  };

  if (actor.role === "ADMIN") {
    updatePayload.owner_id = input.owner_id ?? null;
  }

  const { data: updated, error } = await supabase
    .from("leads")
    .update(updatePayload)
    .eq("id", input.id)
    .eq("customer_id", actor.customerId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, kind: "failed", message: "Something went wrong updating the lead. Please try again." };
  }
  if (!updated) {
    // RLS silently excluded the row (e.g. it closed or was reassigned
    // between the checks above and this statement).
    return {
      ok: false,
      kind: "conflict",
      message: "This lead could not be updated. It may have changed since you opened it.",
    };
  }

  return { ok: true, id: updated.id as string };
}
