"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { createTaskSchema } from "./schemas";
import { getTasksBucketPage, type TasksBucketPage, type TasksBucketPageParams } from "./lib/get-tasks";
import type { TaskFormState } from "./form-state";

/**
 * customer_id and created_by are never read from the form — customer_id
 * is always derived from the caller's own current membership, created_by
 * from the caller's own auth user id, matching every other
 * customer-scoped write in this app (see multi-tenant-security skill /
 * CLAUDE.md Section G). status is never set here either — it always
 * starts at the database's own DEFAULT 'Pending'.
 *
 * AUTHORIZATION: every role may create a task (per spec). Which Lead it
 * can be attached to, and who it can be assigned to, are both re-checked
 * by RLS's "members create tasks for leads and assignees they can see"
 * INSERT policy — the same is_customer_user_visible() hierarchy rule
 * used everywhere else, and the same "can the caller currently see this
 * Lead" check the leads SELECT policy itself uses. This action does not
 * duplicate either check in application code first: an unauthorized
 * lead_id/assigned_to simply fails the INSERT, caught below and turned
 * into a friendly message — the database is the real boundary, exactly
 * like every other role-hierarchy-gated write in this app.
 */
export async function createTaskAction(_prevState: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  const parsed = createTaskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const { error } = await supabase.from("tasks").insert({
    customer_id: membership.customer.id,
    lead_id: parsed.data.lead_id,
    subject: parsed.data.subject,
    description: parsed.data.description ?? null,
    priority: parsed.data.priority,
    due_date: parsed.data.due_date,
    assigned_to: parsed.data.assigned_to,
    type: parsed.data.type,
    created_by: user.id,
  });

  if (error) {
    // Never surface raw Postgres error text (constraint names, internal
    // schema detail) — see CLAUDE.md Section K. A rejected insert here
    // usually means the chosen Lead or assignee is outside what the
    // caller is currently allowed to see/assign — RLS silently rejects
    // rather than naming which check failed.
    return { formError: "Unable to create this task. The lead or assignee may not be available to you." };
  }

  revalidatePath("/tasks");
  revalidatePath("/sales-management");
  return { success: true };
}

export type CompleteTaskResult = { success: boolean; error?: string };

/**
 * Pending -> Completed only. Never deletes — completed tasks remain in
 * the database as history, matching every other "deactivate, don't
 * delete" pattern in this app (customer_lead_stages,
 * customer_catalog_items). Same ADMIN-role-independent shape as
 * setCatalogItemStatusAction: no app-layer role check here beyond
 * authentication, because unlike Catalog's status toggle this isn't
 * ADMIN-only — RLS's "visible-hierarchy members can update a task"
 * policy (is_customer_user_visible(assigned_to)) is what actually
 * decides whether this caller may complete this specific task, and it's
 * the only check that needs to happen: there is no broader role gate to
 * duplicate in application code first.
 */
export async function completeTaskAction(taskId: string): Promise<CompleteTaskResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({ status: "Completed" })
    .eq("id", taskId)
    .eq("customer_id", membership.customer.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return { success: false, error: "Unable to complete this task. Please try again." };
  }
  if (!data) {
    return { success: false, error: "This task could not be updated. It may no longer be available to you." };
  }

  revalidatePath("/tasks");
  return { success: true };
}

/**
 * Callable directly from TaskGroupSection (a Client Component) like an
 * RPC, the same way getCatalogItemsPageAction/completeTaskAction already
 * are — this project has no Route Handlers yet, and this is a read, not
 * a mutation, but Server Actions work equally well for either. customer_id
 * is never accepted as a parameter — always derived from the caller's
 * own current membership, same rule every other customer-scoped query
 * in this app follows.
 */
export async function getTasksBucketPageAction(params: TasksBucketPageParams): Promise<TasksBucketPage> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  return getTasksBucketPage(supabase, membership.customer.id, params);
}
