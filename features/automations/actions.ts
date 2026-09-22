"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { generateWorkflowSchema, saveAutomationSchema, setAutomationStatusSchema } from "./schemas";
import { getTriggerEventType, getTriggerType, validateWorkflow } from "./lib/validate-workflow";
import { buildTeamOptions, generateWorkflow } from "./lib/generate-workflow";
import { processAutomationEvents, WorkerNotConfiguredError } from "./lib/engine";
import { MAX_AI_PROMPT_LENGTH } from "./config/safeguards";
import type { AiBuilderState, AutomationFormState } from "./form-state";
import type { AutomationOrigin, WorkflowDefinition } from "@/types/automation";

const AUTOMATIONS_PATH = "/automations";

/**
 * ADMIN-ONLY, IN BOTH LAYERS, FOR EVERY ACTION IN THIS FILE.
 *
 * The role check here produces the readable refusal; RLS
 * (is_customer_admin(customer_id) on all four automation tables, SELECT
 * included) is the boundary that still holds if one of these checks is
 * ever missed. Same arrangement as lead capture, catalog, lead stages
 * and invitations — CLAUDE.md Section H.
 *
 * NOTHING ABOUT THE TENANT OR THE ROLE COMES FROM THE CLIENT. customer_id
 * is read off the membership this function resolves from the verified
 * session, and no schema in this feature even has a field for it, so
 * there is no value an action could accept by mistake.
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
    return { supabase, user, membership, denied: true as const };
  }

  return { supabase, user, membership, denied: false as const };
}

const DENIED: AutomationFormState = {
  formError: "Only an administrator can manage automations.",
};

/**
 * Saves a draft — creating the automation on first save, and adding a
 * new immutable version on every save after that.
 *
 * WHY A SAVE NEVER DISTURBS WHAT IS RUNNING. An Active automation keeps
 * its `active_version_id` pointing at the version it was activated
 * with. Saving inserts a NEW version row and leaves that pointer alone,
 * so an execution that is in flight — or one that starts a second from
 * now — still reads the exact definition it was activated with. The new
 * work becomes live only when an admin activates it, which is a
 * separate deliberate action.
 *
 * A DRAFT MAY BE INVALID, AN ACTIVATION MAY NOT. Validation issues are
 * returned alongside a successful save rather than blocking it: a
 * half-finished workflow is the normal state of something being built,
 * and refusing to save it would lose an admin's work. setAutomationStatus
 * is where validity becomes mandatory, because that is the moment the
 * thing starts acting on its own.
 */
export async function saveAutomationAction(input: {
  automation_id: string | null;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  origin?: AutomationOrigin;
}): Promise<AutomationFormState> {
  const { supabase, user, membership, denied } = await requireAdmin();
  if (denied) return DENIED;

  const parsed = saveAutomationSchema.safeParse(input);
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error), formError: "This workflow could not be saved as it is." };
  }

  const { automation_id, name, description, definition, origin } = parsed.data;

  const validation = validateWorkflow(definition);
  const triggerType = getTriggerType(definition as WorkflowDefinition);
  const triggerEventType = getTriggerEventType(definition as WorkflowDefinition);

  if (!triggerType) {
    // Stored on the version row and matched in SQL by the engine, so a
    // definition with no trigger has nowhere to be filed. This is the
    // one structural problem a draft cannot be saved with.
    return {
      formError: "Add a trigger before saving. A workflow needs to know what starts it.",
      issues: validation.issues,
    };
  }

  let automationId = automation_id;

  if (automationId) {
    // Explicitly scoped by customer_id as well as id. RLS already
    // restricts this to the caller's tenant; this is the filter that
    // holds if a policy is ever misconfigured, and it turns a
    // cross-tenant id into "not found" rather than an error that
    // confirms the row exists.
    const { data: existing, error: existingError } = await supabase
      .from("customer_automations")
      .select("id, status")
      .eq("customer_id", membership.customer.id)
      .eq("id", automationId)
      .maybeSingle();

    if (existingError || !existing) {
      return { formError: "That automation could not be found." };
    }

    const { error: updateError } = await supabase
      .from("customer_automations")
      .update({ name, description })
      .eq("customer_id", membership.customer.id)
      .eq("id", automationId);

    if (updateError) {
      return { formError: "Unable to save this automation. Please try again." };
    }
  } else {
    const { data: created, error: createError } = await supabase
      .from("customer_automations")
      .insert({
        customer_id: membership.customer.id,
        name,
        description,
        status: "Draft",
        origin,
        created_by: user.id,
      })
      .select("id")
      .maybeSingle();

    if (createError || !created) {
      return { formError: "Unable to create this automation. Please try again." };
    }

    automationId = created.id as string;
  }

  // Next version number. Read rather than computed from a counter column
  // so a concurrent save cannot produce two rows claiming the same
  // number — and if two saves do race, the unique (automation_id,
  // version) constraint rejects the loser rather than silently
  // interleaving them.
  const { data: latest } = await supabase
    .from("customer_automation_versions")
    .select("version")
    .eq("customer_id", membership.customer.id)
    .eq("automation_id", automationId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = ((latest?.version as number | undefined) ?? 0) + 1;

  const { error: versionError } = await supabase.from("customer_automation_versions").insert({
    customer_id: membership.customer.id,
    automation_id: automationId,
    version: nextVersion,
    trigger_type: triggerType,
    trigger_event_type: triggerEventType,
    definition,
    created_by: user.id,
  });

  if (versionError) {
    return {
      formError:
        versionError.code === "23505"
          ? "Someone else saved this automation at the same moment. Reopen it and try again."
          : "Unable to save this version. Please try again.",
    };
  }

  revalidatePath(AUTOMATIONS_PATH);

  return {
    success: true,
    automationId,
    message: validation.ok
      ? `Saved as version ${nextVersion}.`
      : `Saved as version ${nextVersion}, but it cannot be switched on until the problems below are fixed.`,
    issues: validation.ok ? undefined : validation.issues,
  };
}

/**
 * Switches an automation on or off.
 *
 * ACTIVATION IS THE GATE. This is the moment a definition starts acting
 * unattended, so the newest version is re-validated here — against the
 * same validateWorkflow() a hand-built draft went through, with no
 * parameter that could relax it, and regardless of whether a person or
 * a model authored the thing. An invalid workflow cannot be switched on,
 * full stop.
 *
 * Deactivating never validates: an automation that has become invalid
 * must always be switchable OFF.
 */
export async function setAutomationStatusAction(input: {
  automation_id: string;
  status: "Active" | "Inactive";
}): Promise<AutomationFormState> {
  const { supabase, membership, denied } = await requireAdmin();
  if (denied) return DENIED;

  const parsed = setAutomationStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { formError: "That request was not valid." };
  }

  const { automation_id, status } = parsed.data;

  const { data: automation, error } = await supabase
    .from("customer_automations")
    .select("id, name, status")
    .eq("customer_id", membership.customer.id)
    .eq("id", automation_id)
    .maybeSingle();

  if (error || !automation) {
    return { formError: "That automation could not be found." };
  }

  if (status === "Inactive") {
    const { error: pauseError } = await supabase
      .from("customer_automations")
      .update({ status: "Inactive" })
      .eq("customer_id", membership.customer.id)
      .eq("id", automation_id);

    if (pauseError) {
      return { formError: "Unable to switch this automation off. Please try again." };
    }

    revalidatePath(AUTOMATIONS_PATH);
    return { success: true, message: "Switched off. Nothing further will run." };
  }

  const { data: newest, error: versionError } = await supabase
    .from("customer_automation_versions")
    .select("id, version, definition")
    .eq("customer_id", membership.customer.id)
    .eq("automation_id", automation_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (versionError || !newest) {
    return { formError: "This automation has nothing saved yet. Build and save it first." };
  }

  const validation = validateWorkflow(newest.definition);
  if (!validation.ok) {
    return {
      formError: "This workflow cannot be switched on until these are fixed:",
      issues: validation.issues,
    };
  }

  const { error: activateError } = await supabase
    .from("customer_automations")
    .update({ status: "Active", active_version_id: newest.id })
    .eq("customer_id", membership.customer.id)
    .eq("id", automation_id);

  if (activateError) {
    return { formError: "Unable to switch this automation on. Please try again." };
  }

  revalidatePath(AUTOMATIONS_PATH);
  return {
    success: true,
    message: `Switched on. Version ${newest.version} will run from now on, for new leads only.`,
  };
}

/**
 * Turns a plain-English description into a DRAFT definition. Writes
 * nothing.
 *
 * The returned definition still has to be saved by an explicit action
 * and then switched on by another — two deliberate human steps, neither
 * of which this function can take on the admin's behalf. It is an equal
 * entry point to the same builder, not a shortcut past it.
 */
export async function generateWorkflowAction(
  _prevState: AiBuilderState,
  formData: FormData,
): Promise<AiBuilderState> {
  const { supabase, membership, denied } = await requireAdmin();
  if (denied) {
    return { formError: "Only an administrator can create automations." };
  }

  const parsed = generateWorkflowSchema.safeParse({ prompt: formData.get("prompt") });
  if (!parsed.success) {
    return {
      fieldErrors: {
        prompt: `Describe what you want in a sentence or two (up to ${MAX_AI_PROMPT_LENGTH} characters).`,
      },
    };
  }

  // The roster the model may choose from is resolved from the CALLER'S
  // OWN session, through the same hierarchy-aware directory the rest of
  // the app uses. A model cannot name somebody the admin asking could
  // not have picked themselves, because nobody else was ever sent.
  const directory = await getVisibleTeamDirectory(supabase);
  const team = buildTeamOptions(directory);

  const result = await generateWorkflow(parsed.data.prompt, team);

  // Logged as a category only — never the admin's prompt, never the
  // generated definition. Both can carry customer detail.
  console.log(`[automations:ai] generation for customer ${membership.customer.id} returned ${result.status}.`);

  return { result };
}

/**
 * DEV-ONLY manual trigger. Runs the exact same `processAutomationEvents()`
 * the cron route and the opportunistic `after()` drain both call —
 * AWAITED here, not fire-and-forget, so its result can be shown to the
 * admin who asked for it immediately.
 *
 * WHY THIS EXISTS: `next dev` has no equivalent of Vercel Cron running
 * in the background, so outside a deployed environment the opportunistic
 * drain is the ONLY thing that ever processes an event — if it happens
 * to miss (or fails because AUTOMATION_WORKER_TOKEN isn't set yet in
 * this environment), a local admin previously had no way to retry
 * short of waiting or creating another lead. This is that retry,
 * on demand.
 *
 * REFUSED IN PRODUCTION FROM THE ACTION ITSELF, not only by the page
 * omitting the button — the same "never trust the UI alone" discipline
 * as every role check in this file. A production build reaching this
 * function some other way still gets nothing.
 */
export async function processQueueNowAction(): Promise<AutomationFormState> {
  const { denied } = await requireAdmin();
  if (denied) return DENIED;

  if (process.env.NODE_ENV === "production") {
    return { formError: "This is a development-only action." };
  }

  try {
    const result = await processAutomationEvents();
    revalidatePath(AUTOMATIONS_PATH);
    return {
      success: true,
      message:
        result.claimed === 0
          ? "Nothing was waiting to be processed."
          : `Processed ${result.claimed} event${result.claimed === 1 ? "" : "s"}: ${result.succeeded} succeeded, ` +
            `${result.skipped} skipped, ${result.stopped} stopped, ${result.failed} failed.`,
    };
  } catch (error) {
    if (error instanceof WorkerNotConfiguredError) {
      return { formError: error.message };
    }
    return { formError: "Unable to process the queue. Please try again." };
  }
}
