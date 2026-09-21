"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { drainAutomationQueue } from "@/features/automations/lib/drain";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import {
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { searchLeadsForPicker, type LeadSearchResult } from "./lib/search-leads";
import { getLeadLabelsByIds, type LeadLabel } from "./lib/get-lead-labels";
import {
  createLeadSchema,
  createLeadStageSchema,
  updateLeadSchema,
  updateLeadStageSchema,
} from "./schemas";
import type { LeadFormState } from "./form-state";
import type { LeadStageFormState } from "./stage-form-state";

/**
 * Read-only — backs LeadSearchSelect's own live search (Contacts/Tasks
 * create forms and Lead filters). Same thin "resolve membership, delegate
 * to the lib function" shape as getContactsPageAction/
 * getTasksBucketPageAction, just living here in features/leads/ since
 * Lead search belongs to the Leads domain, not either of its two callers.
 */
export async function searchLeadsAction(query: string): Promise<LeadSearchResult[]> {
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

  return searchLeadsForPicker(supabase, membership.customer.id, query);
}

/**
 * Read-only — resolves a bounded set of lead_ids into display labels.
 * Two callers: LeadSearchSelect itself (a controlled `value` arriving
 * from outside whose label this component hasn't seen yet — e.g. a
 * URL-seeded Lead filter on first mount), and ContactList/TaskList
 * resolving the Lead badge/detail/locked-edit-label for whichever
 * contacts/tasks are on the CURRENT page — never the full customer Lead
 * list either way.
 */
export async function getLeadLabelsAction(leadIds: string[]): Promise<LeadLabel[]> {
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

  return getLeadLabelsByIds(supabase, membership.customer.id, leadIds);
}

/**
 * customer_id is never read from the form — it's derived from the
 * caller's own current membership, the same rule every other
 * customer-scoped write in this app follows (see
 * multi-tenant-security skill / CLAUDE.md Section G). owner_id, if
 * supplied, is still constrained to the same customer at the database
 * level regardless (leads_owner_same_customer_fkey, a composite FK
 * against customer_users(customer_id, id)) — this isn't the only layer,
 * just the first one.
 *
 * OWNER AUTHORIZATION: only an ADMIN may choose who a lead is assigned
 * to. Everyone else has the "Owner" field forced to their own
 * customer_users.id, regardless of what (if anything) the form
 * submitted for owner_id — a non-admin cannot assign a lead to another
 * user by hand-crafting a request, because their submitted value is
 * simply never read for that branch. The leads INSERT policy
 * ("members create leads owned by themselves, admins by anyone", see
 * 20260906120000_lead_hierarchy_and_optional_fields.sql) enforces the
 * same rule again at the database level, independent of this check —
 * so the invariant holds even if this Server Action is bypassed
 * entirely and Supabase is called directly.
 *
 * STAGE AUTHORIZATION: the composite same-customer-safe FK
 * (leads_stage_same_customer_fkey) already guarantees stage_id belongs
 * to this customer at the database level regardless of what this action
 * does — a cross-customer stage_id fails the INSERT outright. This
 * action additionally re-fetches the stage server-side (through the
 * caller's own RLS-scoped client, so a cross-customer id simply won't
 * be found at all) and rejects an Inactive stage explicitly — "must be
 * Active" is intentionally a create-time check only, not a standing DB
 * constraint, since an already-created lead must remain valid even
 * after its stage is later deactivated (see customer_lead_stages'
 * design notes).
 */
export async function createLeadAction(
  _prevState: LeadFormState,
  formData: FormData,
): Promise<LeadFormState> {
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

  const raw = Object.fromEntries(formData);
  const parsed = createLeadSchema.safeParse({
    ...raw,
    // An empty <select> value ("") means "no owner chosen" — normalize
    // before validation so it hits the optional-field branch, not a
    // failed one.
    owner_id: raw.owner_id || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const { data: stage, error: stageError } = await supabase
    .from("customer_lead_stages")
    .select("id, status")
    .eq("id", parsed.data.stage_id)
    .eq("customer_id", membership.customer.id)
    .maybeSingle();

  if (stageError || !stage) {
    return { fieldErrors: { stage_id: "Select a valid stage." } };
  }
  if (stage.status !== "Active") {
    return { fieldErrors: { stage_id: "That stage is no longer active. Please choose another." } };
  }

  const ownerId = membership.role === "ADMIN" ? (parsed.data.owner_id ?? null) : membership.membership.id;

  // "same as contact number" is resolved authoritatively here, not
  // trusted from any client-side copy — if checked, whatever the form
  // submitted for whatsapp_phone is ignored in favor of `phone` itself.
  const whatsappPhone = parsed.data.whatsapp_same ? parsed.data.phone : (parsed.data.whatsapp_phone ?? null);

  const { error } = await supabase.from("leads").insert({
    customer_id: membership.customer.id,
    company: parsed.data.company ?? null,
    contact_name: parsed.data.contact_name,
    email: parsed.data.email ?? null,
    phone: parsed.data.phone,
    whatsapp_phone: whatsappPhone,
    address: parsed.data.address ?? null,
    deal_value: parsed.data.deal_value ?? null,
    expected_close_date: parsed.data.expected_close_date ?? null,
    stage_id: parsed.data.stage_id,
    owner_id: ownerId,
    source: parsed.data.source ?? null,
    next_step: parsed.data.next_step ?? null,
  });

  if (error) {
    return { formError: "Something went wrong creating the lead. Please try again." };
  }

  // The lead row's own AFTER INSERT trigger has already written any
  // automation event, inside the same transaction as the insert above.
  // This only nudges the worker to pick it up now rather than waiting
  // for the cron backstop — after(), so it runs once this action's
  // response is on its way and can neither slow the form down nor fail
  // it. See features/automations/lib/drain.ts.
  after(() => drainAutomationQueue("a lead was created"));

  revalidatePath("/sales-management");
  revalidatePath("/forecast");
  return { success: true };
}

/**
 * Edits an existing lead. Every check below is UX only — the database
 * (protect_lead_stage_transition, leads_protect_owner_id_change, and the
 * "owners or admins can update a lead" RLS policy) is what actually
 * holds if any of this were ever wrong or bypassed entirely.
 *
 * CLOSED-LEAD LOCK: re-checked here explicitly (fetch the lead, reject
 * if closed_at is already set) purely to surface a clear error message —
 * the trigger rejects the UPDATE statement outright regardless, and the
 * RLS policy's USING clause (closed_at is null) would silently exclude
 * the row from the update even if this check were removed.
 *
 * OWNERSHIP: only an ADMIN, or the lead's own current owner, may edit it
 * at all — matching the RLS UPDATE policy exactly (it does NOT extend
 * edit rights to a manager over their team's leads, only hierarchy-aware
 * *visibility*; see 20260906120000's design notes). owner_id itself is
 * only ever included in the update payload when the caller is an ADMIN —
 * a non-admin's submitted owner_id is never read, the same pattern
 * createLeadAction uses, so a hand-crafted request can't reassign a lead
 * even if the UI's role gate were somehow bypassed.
 *
 * STAGE: only re-validated as "must be Active" when stage_id is actually
 * changing — identical rule to protect_lead_stage_transition() itself,
 * so an edit that leaves a lead sitting on a since-deactivated stage
 * unchanged is never blocked just because of that.
 */
export async function updateLeadAction(
  _prevState: LeadFormState,
  formData: FormData,
): Promise<LeadFormState> {
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

  const raw = Object.fromEntries(formData);
  const parsed = updateLeadSchema.safeParse({
    ...raw,
    owner_id: raw.owner_id || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const { data: existingLead, error: fetchError } = await supabase
    .from("leads")
    .select("id, owner_id, stage_id, closed_at")
    .eq("id", parsed.data.id)
    .eq("customer_id", membership.customer.id)
    .maybeSingle();

  if (fetchError || !existingLead) {
    return { formError: "Lead not found." };
  }

  if (existingLead.closed_at) {
    return { formError: "This lead is closed and cannot be edited." };
  }

  const isOwnLead = existingLead.owner_id === membership.membership.id;
  if (membership.role !== "ADMIN" && !isOwnLead) {
    return { formError: "You don't have permission to edit this lead." };
  }

  if (parsed.data.stage_id !== existingLead.stage_id) {
    const { data: stage, error: stageError } = await supabase
      .from("customer_lead_stages")
      .select("id, status")
      .eq("id", parsed.data.stage_id)
      .eq("customer_id", membership.customer.id)
      .maybeSingle();

    if (stageError || !stage) {
      return { fieldErrors: { stage_id: "Select a valid stage." } };
    }
    if (stage.status !== "Active") {
      return { fieldErrors: { stage_id: "That stage is no longer active. Please choose another." } };
    }
  }

  const whatsappPhone = parsed.data.whatsapp_same ? parsed.data.phone : (parsed.data.whatsapp_phone ?? null);

  const updatePayload: Record<string, unknown> = {
    company: parsed.data.company ?? null,
    contact_name: parsed.data.contact_name,
    email: parsed.data.email ?? null,
    phone: parsed.data.phone,
    whatsapp_phone: whatsappPhone,
    address: parsed.data.address ?? null,
    deal_value: parsed.data.deal_value ?? null,
    expected_close_date: parsed.data.expected_close_date ?? null,
    stage_id: parsed.data.stage_id,
    source: parsed.data.source ?? null,
    next_step: parsed.data.next_step ?? null,
  };

  if (membership.role === "ADMIN") {
    updatePayload.owner_id = parsed.data.owner_id ?? null;
  }

  const { data: updated, error } = await supabase
    .from("leads")
    .update(updatePayload)
    .eq("id", parsed.data.id)
    .eq("customer_id", membership.customer.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return { formError: "Something went wrong updating the lead. Please try again." };
  }
  if (!updated) {
    // RLS silently excluded the row (e.g. it closed or was reassigned
    // between the checks above and this statement) — the database is
    // still the real boundary even when this action's own checks agree.
    return { formError: "This lead could not be updated. It may have changed since you opened it." };
  }

  revalidatePath("/sales-management");
  revalidatePath("/forecast");
  return { success: true };
}

/**
 * The two stage-outcome rules the database enforces with CHECK
 * constraints, applied here first so a legitimate admin never sees a raw
 * constraint violation.
 *
 * RULE 1 — REJECTED, not corrected: is_won requires is_closed.
 *   "This stage is a win" and "this stage is still open" are
 *   contradictory statements about the business, and there is no way to
 *   tell which one the admin meant — silently clearing either flag could
 *   reclassify live deals (a stage flipping to closed LOCKS every lead in
 *   it, permanently, via protect_lead_stage_transition). So this returns
 *   a field error and writes nothing. The Stage Settings dialog also
 *   makes the combination unreachable by unchecking "counts as won"
 *   whenever "closed" is unchecked, so in practice this is the guard for
 *   a crafted request, not for the UI — but it is a real guard either
 *   way, because the UI is not the boundary.
 *
 * RULE 2 — CORRECTED, not rejected: probability is derived for closed
 *   stages (won = 100, any other closed stage = 0). Unlike rule 1 there
 *   is no ambiguity about intent here: the outcome flags fully determine
 *   the only legal value, so normalizing is the correct, non-destructive
 *   thing to do. The dialog renders that derived value as a read-only
 *   input, so an admin never types a number this then overrides.
 *
 * Returns either a field error to hand straight back as the action's
 * result, or the probability to persist.
 */
function resolveStageOutcome(input: {
  is_closed: boolean;
  is_won: boolean;
  probability: number;
}): { error: LeadStageFormState } | { probability: number } {
  if (input.is_won && !input.is_closed) {
    return {
      error: {
        fieldErrors: {
          is_won: "A stage can only count as won if it is also marked as a closed stage.",
        },
      },
    };
  }

  if (input.is_won) return { probability: 100 };
  if (input.is_closed) return { probability: 0 };
  return { probability: input.probability };
}

/**
 * Stage configuration actions below are all ADMIN-role-gated — note this
 * is the ADMIN *role* (membership.role === "ADMIN", one of the four
 * roles every customer_user has), a different concept from
 * "isPrimaryAdmin" (customers.created_by === the caller, used to gate
 * editing Company Information's own fields). A customer can have
 * multiple ADMIN-role users; stage configuration is available to all of
 * them, matching the master spec's Section 25 exactly. RLS
 * ("admins can create/update their customer's lead stages", using
 * is_customer_admin() — role-based, same check) is the real boundary;
 * these membership.role checks are the UX layer that keeps a non-admin
 * from even reaching a working form.
 */

export async function createLeadStageAction(
  _prevState: LeadStageFormState,
  formData: FormData,
): Promise<LeadStageFormState> {
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
  if (membership.role !== "ADMIN") {
    return { formError: "Only an admin can configure lead stages." };
  }

  const parsed = createLeadStageSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const outcome = resolveStageOutcome(parsed.data);
  if ("error" in outcome) {
    return outcome.error;
  }

  const { data: nextOrder } = await supabase
    .from("customer_lead_stages")
    .select("display_order")
    .eq("customer_id", membership.customer.id)
    .order("display_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("customer_lead_stages").insert({
    customer_id: membership.customer.id,
    stage: parsed.data.stage,
    display_order: (nextOrder?.display_order ?? 0) + 1,
    is_closed: parsed.data.is_closed,
    is_won: parsed.data.is_won,
    probability: outcome.probability,
  });

  if (error) {
    // 23505 = unique_violation — the case/whitespace-insensitive name
    // index (customer_lead_stages_unique_name_per_customer) is the only
    // uniqueness constraint on this table, so this is unambiguous.
    if (error.code === "23505") {
      return { fieldErrors: { stage: "A stage with this name already exists." } };
    }
    if (error.code === "23514") {
      return {
        formError: "That combination of closed/won and probability isn't allowed. Please review the fields and try again.",
      };
    }
    return { formError: "Something went wrong creating the stage. Please try again." };
  }

  revalidatePath("/settings/company-information");
  revalidatePath("/sales-management");
  revalidatePath("/forecast");
  return { success: true };
}

export async function updateLeadStageAction(
  _prevState: LeadStageFormState,
  formData: FormData,
): Promise<LeadStageFormState> {
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
  if (membership.role !== "ADMIN") {
    return { formError: "Only an admin can configure lead stages." };
  }

  const parsed = updateLeadStageSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const outcome = resolveStageOutcome(parsed.data);
  if ("error" in outcome) {
    return outcome.error;
  }

  const { error } = await supabase
    .from("customer_lead_stages")
    .update({
      stage: parsed.data.stage,
      is_closed: parsed.data.is_closed,
      is_won: parsed.data.is_won,
      probability: outcome.probability,
    })
    .eq("id", parsed.data.id)
    .eq("customer_id", membership.customer.id);

  if (error) {
    if (error.code === "23505") {
      return { fieldErrors: { stage: "A stage with this name already exists." } };
    }
    // 23514 = check_violation. resolveStageOutcome above should make both
    // of this table's outcome CHECKs unreachable; this exists so that if
    // one is ever hit anyway, it still reads as a sentence rather than as
    // Postgres constraint text (CLAUDE.md Section K — never surface raw
    // database error text).
    if (error.code === "23514") {
      return {
        formError: "That combination of closed/won and probability isn't allowed. Please review the fields and try again.",
      };
    }
    return { formError: "Something went wrong updating the stage. Please try again." };
  }

  revalidatePath("/settings/company-information");
  revalidatePath("/sales-management");
  revalidatePath("/forecast");
  return { success: true };
}

/**
 * Activate/deactivate is intentionally a separate, tiny action from
 * rename/closed-toggle above — it's triggered by a single click (no
 * form/dialog), not worth sharing a schema with the richer edit form.
 */
export async function setLeadStageStatusAction(stageId: string, status: "Active" | "Inactive"): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) redirect(await getNoMembershipRedirect(supabase, user.id));
  if (membership.role !== "ADMIN") return;

  await supabase
    .from("customer_lead_stages")
    .update({ status })
    .eq("id", stageId)
    .eq("customer_id", membership.customer.id);

  revalidatePath("/settings/company-information");
  revalidatePath("/sales-management");
  revalidatePath("/forecast");
}

/**
 * Swaps display_order with the immediately-preceding ("up") or
 * -following ("down") stage in the customer's own full stage list
 * (active and inactive together — reordering happens over exactly the
 * list the settings UI shows). No uniqueness constraint exists on
 * display_order, so two independent updates are enough; there's no
 * transient-violation window to worry about.
 */
export async function reorderLeadStageAction(stageId: string, direction: "up" | "down"): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) redirect(await getNoMembershipRedirect(supabase, user.id));
  if (membership.role !== "ADMIN") return;

  const { data: stages } = await supabase
    .from("customer_lead_stages")
    .select("id, display_order")
    .eq("customer_id", membership.customer.id)
    .order("display_order", { ascending: true });

  if (!stages) return;

  const index = stages.findIndex((s) => s.id === stageId);
  if (index === -1) return;

  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= stages.length) return;

  const current = stages[index];
  const swapWith = stages[swapIndex];

  await Promise.all([
    supabase
      .from("customer_lead_stages")
      .update({ display_order: swapWith.display_order })
      .eq("id", current.id)
      .eq("customer_id", membership.customer.id),
    supabase
      .from("customer_lead_stages")
      .update({ display_order: current.display_order })
      .eq("id", swapWith.id)
      .eq("customer_id", membership.customer.id),
  ]);

  revalidatePath("/settings/company-information");
  revalidatePath("/sales-management");
  revalidatePath("/forecast");
}

export type MoveLeadStageResult = { success: boolean; error?: string };

/**
 * Changes only a lead's stage_id — the mutation the Pipeline board's
 * drag-and-drop calls on a successful drop. Deliberately a separate,
 * smaller action rather than routing drag-and-drop through
 * updateLeadAction: that action's schema (updateLeadSchema) requires the
 * lead's entire editable form payload (contact_name, phone, email, ...),
 * which a drag event never has and shouldn't need to resubmit just to
 * move one card. What IS reused, line for line, is updateLeadAction's own
 * authorization/validation logic:
 *   - closed_at lock check (a closed lead can't be moved, matching the
 *     "This lead is closed and read-only" rule everywhere else)
 *   - ownership check (ADMIN, or the lead's own current owner — the same
 *     rule the "owners or admins can update a lead" RLS policy enforces)
 *   - target-stage validity (must exist for this customer, must be
 *     Active) when stage_id is actually changing
 * All of it is UX only, same as updateLeadAction's own copies of these
 * checks — protect_lead_stage_transition() (the BEFORE UPDATE trigger)
 * and the RLS UPDATE policy are what actually hold if this were ever
 * bypassed. The trigger also computes closed_at itself the moment the
 * target stage's is_closed is true, so dropping a card into a closed
 * column (e.g. Won/Lost) locks it automatically — nothing here sets
 * closed_at directly.
 */
export async function moveLeadStageAction(leadId: string, stageId: string): Promise<MoveLeadStageResult> {
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

  const { data: existingLead, error: fetchError } = await supabase
    .from("leads")
    .select("id, owner_id, stage_id, closed_at")
    .eq("id", leadId)
    .eq("customer_id", membership.customer.id)
    .maybeSingle();

  if (fetchError || !existingLead) {
    return { success: false, error: "This lead could not be found." };
  }

  if (existingLead.closed_at) {
    return { success: false, error: "This lead is closed and cannot be moved." };
  }

  const isOwnLead = existingLead.owner_id === membership.membership.id;
  if (membership.role !== "ADMIN" && !isOwnLead) {
    return { success: false, error: "You don't have permission to move this lead." };
  }

  if (stageId !== existingLead.stage_id) {
    const { data: stage, error: stageError } = await supabase
      .from("customer_lead_stages")
      .select("id, status")
      .eq("id", stageId)
      .eq("customer_id", membership.customer.id)
      .maybeSingle();

    if (stageError || !stage) {
      return { success: false, error: "That stage could not be found." };
    }
    if (stage.status !== "Active") {
      return { success: false, error: "That stage is no longer active." };
    }
  }

  const { data: updated, error } = await supabase
    .from("leads")
    .update({ stage_id: stageId })
    .eq("id", leadId)
    .eq("customer_id", membership.customer.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return { success: false, error: "Something went wrong moving this lead. Please try again." };
  }
  if (!updated) {
    // RLS silently excluded the row (e.g. it closed between the checks
    // above and this statement) — the database is still the real
    // boundary even when this action's own checks agree.
    return { success: false, error: "This lead could not be moved. It may have changed since the board loaded." };
  }

  revalidatePath("/sales-management");
  revalidatePath("/forecast");
  return { success: true };
}
