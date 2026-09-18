"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import {
  integrationIdSchema,
  setIntegrationStatusSchema,
  updateIntegrationSettingsSchema,
} from "./schemas";
import { initialIntegrationFormState, type IntegrationFormState } from "./form-state";

const LEAD_CAPTURE_PATH = "/lead-capture";

/**
 * ADMIN-ONLY, in both layers, for every action in this file.
 *
 * The role check here is the readable error; RLS
 * (is_customer_admin(customer_id) on customer_integrations and
 * customer_integration_participants, SELECT included) is the boundary
 * that holds even if one of these checks is ever missed. Same
 * arrangement as catalog, lead stages and invitations — see CLAUDE.md
 * Section H.
 *
 * Returns the caller's membership, or performs the redirect/error
 * itself. Every action starts with this and nothing else.
 */
async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  if (membership.role !== "ADMIN") {
    return { supabase, membership, denied: true as const };
  }

  return { supabase, membership, denied: false as const };
}

const DENIED: IntegrationFormState = {
  formError: "Only an administrator can configure lead capture.",
};

/**
 * Create the IndiaMART integration row for this customer.
 *
 * WHY THIS IS AN EXPLICIT ACTION rather than something the page does on
 * first view: creating the row mints a live webhook token. A tenant
 * that has never set this up should not acquire a working ingest URL
 * just because somebody opened the settings page once.
 *
 * The token is NOT generated here. It comes from the column DEFAULT in
 * the migration, so there is exactly one place in the system that
 * decides what a token looks like, and application code never handles
 * token generation at all.
 *
 * customer_id comes from the caller's own membership. Nothing is read
 * from the form for it.
 */
export async function connectIndiamartAction(): Promise<IntegrationFormState> {
  const { supabase, membership, denied } = await requireAdmin();
  if (denied) return DENIED;

  const { error } = await supabase.from("customer_integrations").insert({
    customer_id: membership.customer.id,
    source: "IndiaMART",
  });

  if (error) {
    // 23505 = unique_violation: customer_integrations_source_key, i.e.
    // two admins pressed Connect at once. The desired end state already
    // exists, so this is reported as success rather than as a failure
    // the second admin has to understand.
    if (error.code === "23505") {
      revalidatePath(LEAD_CAPTURE_PATH);
      return { success: true, message: "IndiaMART is connected." };
    }
    console.error(`[lead-capture] connect failed (code: ${error.code}).`);
    return { formError: "Could not connect IndiaMART. Please try again." };
  }

  revalidatePath(LEAD_CAPTURE_PATH);
  return { success: true, message: "IndiaMART connected. Copy the webhook URL below." };
}

/**
 * Mint a new webhook token, invalidating the old URL immediately.
 *
 * `webhook_token: DEFAULT` cannot be expressed through PostgREST, so
 * this is the one place a token value is produced outside the column
 * default — via the same two-uuid construction, kept deliberately
 * identical. The alternative (a dedicated RPC) would be a second
 * SECURITY DEFINER function for one UPDATE that RLS already guards
 * correctly.
 */
export async function regenerateWebhookTokenAction(
  _prevState: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const { supabase, membership, denied } = await requireAdmin();
  if (denied) return DENIED;

  const parsed = integrationIdSchema.safeParse({
    integration_id: formData.get("integration_id"),
  });
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;

  const { error } = await supabase
    .from("customer_integrations")
    .update({ webhook_token: token })
    .eq("id", parsed.data.integration_id)
    // Belt and braces on top of RLS — an id from a form is untrusted
    // input, and this makes the tenant scope explicit at the call site.
    .eq("customer_id", membership.customer.id);

  if (error) {
    console.error(`[lead-capture] token regeneration failed (code: ${error.code}).`);
    return { formError: "Could not regenerate the webhook URL. Please try again." };
  }

  revalidatePath(LEAD_CAPTURE_PATH);
  return {
    success: true,
    message: "New webhook URL generated. Update it in IndiaMART — the previous URL no longer works.",
  };
}

export async function setIntegrationStatusAction(
  _prevState: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const { supabase, membership, denied } = await requireAdmin();
  if (denied) return DENIED;

  const parsed = setIntegrationStatusSchema.safeParse({
    integration_id: formData.get("integration_id"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const { error } = await supabase
    .from("customer_integrations")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.integration_id)
    .eq("customer_id", membership.customer.id);

  if (error) {
    console.error(`[lead-capture] status change failed (code: ${error.code}).`);
    return { formError: "Could not change the connection status. Please try again." };
  }

  revalidatePath(LEAD_CAPTURE_PATH);
  return {
    success: true,
    message:
      parsed.data.status === "Active"
        ? "IndiaMART capture resumed."
        : "IndiaMART capture paused. Incoming leads will be rejected until you resume it.",
  };
}

/**
 * Save the default stage, the assignment mode, the Fixed owner, and the
 * round-robin roster.
 *
 * THE ROSTER IS DIFFED, NEVER REPLACED — and that is the important part
 * of this function.
 *
 * The easy implementation is "delete every participant row, insert the
 * submitted list". It would be wrong: rotation order is
 * (created_at, id), so re-inserting everybody rewrites every
 * created_at. Adding one person to a four-person rotation would
 * silently reshuffle the other three and restart the cycle. An admin
 * adding a fifth rep must not disturb whose turn it is.
 *
 * So rows that survive are left completely untouched, only removals are
 * deleted, and only genuinely new people are inserted. Existing
 * rotation state (customer_integrations.last_assigned_owner_id) stays
 * valid through the change, and a removed participant is handled by the
 * webhook's own wrap-to-start path.
 */
export async function updateIntegrationSettingsAction(
  _prevState: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const { supabase, membership, denied } = await requireAdmin();
  if (denied) return DENIED;

  const parsed = updateIntegrationSettingsSchema.safeParse({
    integration_id: formData.get("integration_id"),
    default_stage_id: formData.get("default_stage_id"),
    assignment_mode: formData.get("assignment_mode"),
    default_owner_id: formData.get("default_owner_id"),
    // getAll, not get: TeamSelect in `multiple` mode renders one hidden
    // input per selected person, all sharing this name.
    participants: formData.getAll("participants").filter((value): value is string => typeof value === "string" && value !== ""),
  });

  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const { integration_id, default_stage_id, assignment_mode, default_owner_id, participants } = parsed.data;

  const { error: updateError } = await supabase
    .from("customer_integrations")
    .update({
      default_stage_id,
      assignment_mode,
      default_owner_id,
    })
    .eq("id", integration_id)
    .eq("customer_id", membership.customer.id);

  if (updateError) {
    // 23503 = foreign_key_violation. The composite same-customer FKs
    // are what would reject a stage or owner belonging to another
    // tenant, so this is the constraint layer doing its job — reported
    // as a field error rather than a raw Postgres message (CLAUDE.md
    // Section K).
    if (updateError.code === "23503") {
      return { fieldErrors: { default_owner_id: "That stage or team member is no longer available." } };
    }
    console.error(`[lead-capture] settings save failed (code: ${updateError.code}).`);
    return { formError: "Could not save these settings. Please try again." };
  }

  // Read the current roster to diff against. RLS already scopes this to
  // the caller's customer.
  const { data: existingRows, error: rosterError } = await supabase
    .from("customer_integration_participants")
    .select("customer_user_id")
    .eq("integration_id", integration_id);

  if (rosterError) {
    console.error(`[lead-capture] could not read roster (code: ${rosterError.code}).`);
    return {
      formError: "Stage and assignment mode were saved, but the round-robin list could not be updated.",
    };
  }

  const existing = new Set((existingRows ?? []).map((row) => row.customer_user_id as string));
  const desired = new Set(participants);

  const toRemove = [...existing].filter((id) => !desired.has(id));
  const toAdd = participants.filter((id) => !existing.has(id));

  if (toRemove.length > 0) {
    const { error } = await supabase
      .from("customer_integration_participants")
      .delete()
      .eq("integration_id", integration_id)
      .in("customer_user_id", toRemove);

    if (error) {
      console.error(`[lead-capture] roster removal failed (code: ${error.code}).`);
      return { formError: "Could not update the round-robin list. Please try again." };
    }
  }

  if (toAdd.length > 0) {
    const { error } = await supabase.from("customer_integration_participants").insert(
      toAdd.map((customerUserId) => ({
        // customer_id from the caller's membership, never from the form.
        customer_id: membership.customer.id,
        integration_id,
        customer_user_id: customerUserId,
      })),
    );

    if (error) {
      if (error.code === "23503") {
        return { fieldErrors: { participants: "One of those team members is no longer available." } };
      }
      console.error(`[lead-capture] roster insert failed (code: ${error.code}).`);
      return { formError: "Could not update the round-robin list. Please try again." };
    }
  }

  revalidatePath(LEAD_CAPTURE_PATH);
  return { success: true, message: "Lead capture settings saved." };
}

export { initialIntegrationFormState };
