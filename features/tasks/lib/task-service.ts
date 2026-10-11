import type { SupabaseClient } from "@supabase/supabase-js";
import type { DomainActor, DomainWriteResult } from "@/types/customer";
import type { CreateTaskInput, UpdateTaskInput } from "../schemas";

/**
 * THE ONE BUSINESS-LOGIC PATH FOR CREATING, EDITING AND COMPLETING A TASK.
 *
 * Moved line for line out of createTaskAction/updateTaskAction/
 * completeTaskAction (features/tasks/actions.ts) so the Server Actions and
 * the MCP create_task/update_task/complete_task tools run identical rules
 * on a client already authenticated as the acting person. Same split as
 * features/leads/lib/lead-service.ts: auth, membership, Zod and
 * revalidatePath stay with the caller.
 *
 * AUTHORIZATION is RLS, exactly as before: "members create tasks for leads
 * and assignees they can see" and "visible-hierarchy members can update a
 * task" (is_customer_user_visible on both USING and WITH CHECK). Nothing
 * here duplicates those checks; an unauthorized lead/assignee fails the
 * INSERT, an unauthorized update matches zero rows. Automation events are
 * written by the tasks table's own AFTER trigger, inside the same
 * statement, whichever caller wrote the row.
 */

export async function createTask(
  supabase: SupabaseClient,
  actor: DomainActor,
  input: CreateTaskInput,
): Promise<DomainWriteResult> {
  const { data: created, error } = await supabase
    .from("tasks")
    .insert({
      customer_id: actor.customerId,
      lead_id: input.lead_id,
      subject: input.subject,
      description: input.description ?? null,
      priority: input.priority,
      due_date: input.due_date,
      assigned_to: input.assigned_to,
      type: input.type,
      created_by: actor.userId,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // Never surface raw Postgres error text — RLS rejects without naming
    // which check failed.
    return {
      ok: false,
      kind: "failed",
      message: "Unable to create this task. The lead or assignee may not be available to you.",
    };
  }

  // The id may legitimately be absent (see createTaskAction's own note);
  // that is still a success.
  return { ok: true, id: (created?.id as string | undefined) ?? null };
}

export async function updateTask(
  supabase: SupabaseClient,
  actor: DomainActor,
  input: UpdateTaskInput,
): Promise<DomainWriteResult> {
  const { data: updated, error } = await supabase
    .from("tasks")
    .update({
      subject: input.subject,
      description: input.description ?? null,
      priority: input.priority,
      due_date: input.due_date,
      assigned_to: input.assigned_to,
      type: input.type,
      status: input.status,
    })
    .eq("id", input.id)
    .eq("customer_id", actor.customerId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, kind: "failed", message: "Unable to update this task. The assignee may not be available to you." };
  }
  if (!updated) {
    return {
      ok: false,
      kind: "not_found",
      message: "This task could not be updated. It may no longer be available to you.",
    };
  }

  return { ok: true, id: updated.id as string };
}

/** Pending -> Completed. Never deletes. */
export async function completeTask(
  supabase: SupabaseClient,
  actor: DomainActor,
  taskId: string,
): Promise<DomainWriteResult> {
  const { data, error } = await supabase
    .from("tasks")
    .update({ status: "Completed" })
    .eq("id", taskId)
    .eq("customer_id", actor.customerId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, kind: "failed", message: "Unable to complete this task. Please try again." };
  }
  if (!data) {
    return {
      ok: false,
      kind: "not_found",
      message: "This task could not be updated. It may no longer be available to you.",
    };
  }

  return { ok: true, id: data.id as string };
}
