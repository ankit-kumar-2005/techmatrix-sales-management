import { z } from "zod";
import { BRAND_NAME } from "@/lib/brand";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { createTaskSchema, updateTaskSchema } from "@/features/tasks/schemas";
import { completeTask, createTask, updateTask } from "@/features/tasks/lib/task-service";
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from "@/types/task";
import { MCP_DEFAULT_RESULTS_PER_CALL } from "../../config/limits";
import { invalidInput, notFound } from "../../lib/errors";
import { projectTask } from "../../lib/output";
import { applyConditions, applySortAndLimit, searchInputSchema, validateFilters, type FilterableQuery } from "../filters";
import { TASK_FILTERS, TASK_SELECT } from "../fields";
import type { McpToolDefinition } from "../types";
import {
  assigneeId,
  fieldErrorsMessage,
  idempotencyKey,
  isoDate,
  loadLookups,
  readFailed,
  recordId,
  runQuery,
  unwrapDomainResult,
} from "./shared";

// ---------------------------------------------------------------------
// search_tasks
// ---------------------------------------------------------------------

const searchTasksInput = searchInputSchema(TASK_FILTERS, {
  assigned_to_me: z.boolean().optional().describe("Only tasks assigned to you."),
});

export const searchTasks: McpToolDefinition<z.infer<typeof searchTasksInput>> = {
  name: "search_tasks",
  label: "Search tasks",
  summary: "Find tasks by status, due date, priority and type.",
  description:
    "Search the tasks this person can see. Filter with structured conditions (field, operator, value). " +
    "Sorted by due date (soonest first) unless another sort is given. Each task includes the lead it belongs to.",
  group: "Tasks",
  kind: "read",
  capability: "read",
  idempotent: false,
  inputSchema: searchTasksInput,
  outputFields: ["tasks", "returned", "has_more"],
  async handler(context, input) {
    const conditions = validateFilters(TASK_FILTERS, input.filters ?? []);
    const limit = input.limit ?? MCP_DEFAULT_RESULTS_PER_CALL;

    let query = context.supabase
      .from("tasks")
      .select(TASK_SELECT)
      .eq("customer_id", context.actor.customerId) as unknown as FilterableQuery;
    if (input.assigned_to_me) query = query.eq("assigned_to", context.actor.customerUserId);
    query = applySortAndLimit(applyConditions(query, conditions), TASK_FILTERS, input.sort, limit);

    const { data, error } = await runQuery(query);
    if (error || !Array.isArray(data)) throw readFailed();

    const rows = (data as Record<string, unknown>[]).slice(0, limit);
    const lookups = await loadLookups(context, { people: true, leadIds: rows.map((row) => String(row.lead_id)) });
    return {
      data: { tasks: rows.map((row) => projectTask(row, lookups)), returned: rows.length, has_more: data.length > limit },
      recordIds: rows.map((row) => String(row.id)),
    };
  },
};

// ---------------------------------------------------------------------
// get_task
// ---------------------------------------------------------------------

const getTaskInput = z.object({ id: recordId("id") });

async function fetchTask(context: Parameters<McpToolDefinition["handler"]>[0], id: string) {
  const { data, error } = await context.supabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("id", id)
    .eq("customer_id", context.actor.customerId)
    .maybeSingle();
  if (error) throw readFailed();
  if (!data) throw notFound();
  return data as Record<string, unknown>;
}

export const getTask: McpToolDefinition<z.infer<typeof getTaskInput>> = {
  name: "get_task",
  label: "View a task",
  summary: "Open one task.",
  description: "Get one task by id.",
  group: "Tasks",
  kind: "read",
  capability: "read",
  idempotent: false,
  inputSchema: getTaskInput,
  outputFields: ["task"],
  async handler(context, input) {
    const row = await fetchTask(context, input.id);
    const lookups = await loadLookups(context, { people: true, leadIds: [String(row.lead_id)] });
    return { data: { task: projectTask(row, lookups) }, recordIds: [input.id] };
  },
};

// ---------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------

const createTaskInput = z.object({
  subject: z.string().min(1).max(200).describe("What needs doing."),
  lead_id: recordId("lead_id").describe("The lead this task belongs to."),
  due_date: isoDate("due_date").describe("YYYY-MM-DD."),
  priority: z.enum(TASK_PRIORITIES).optional().describe("Defaults to Medium."),
  type: z.enum(TASK_TYPES).optional().describe("Defaults to Other."),
  description: z.string().max(4000).optional(),
  assignee_id: assigneeId(),
  idempotency_key: idempotencyKey(),
});

export const createTaskTool: McpToolDefinition<z.infer<typeof createTaskInput>> = {
  name: "create_task",
  label: "Create tasks",
  summary: "Add a follow-up task to a lead.",
  description:
    `Create a task on a lead. Same rules as ${BRAND_NAME}: the lead and the assignee must both be visible to this person. ` +
    "Assigned to the caller unless assignee_id is given. Ask the user to confirm before calling.",
  group: "Tasks",
  kind: "write",
  capability: "create",
  idempotent: true,
  replayTable: "tasks",
  inputSchema: createTaskInput,
  outputFields: ["id", "created", "replayed"],
  async handler(context, input) {
    const parsed = createTaskSchema.safeParse({
      subject: input.subject,
      description: input.description ?? "",
      priority: input.priority ?? "Medium",
      due_date: input.due_date,
      assigned_to: input.assignee_id ?? context.actor.customerUserId,
      lead_id: input.lead_id,
      type: input.type ?? "Other",
    });
    if (!parsed.success) throw invalidInput(fieldErrorsMessage(getFieldErrors(parsed.error)));

    const id = unwrapDomainResult(await createTask(context.supabase, context.actor, parsed.data), "forbidden");
    return { data: { id, created: true }, recordIds: id ? [id] : [] };
  },
};

// ---------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------

const updateTaskInput = z.object({
  id: recordId("id"),
  subject: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional().describe("Send null to clear."),
  priority: z.enum(TASK_PRIORITIES).optional(),
  due_date: isoDate("due_date").optional(),
  type: z.enum(TASK_TYPES).optional(),
  status: z.enum(TASK_STATUSES).optional().describe("Pending or Completed."),
  assignee_id: assigneeId().describe("Reassign to this team member."),
});

export const updateTaskTool: McpToolDefinition<z.infer<typeof updateTaskInput>> = {
  name: "update_task",
  label: "Update tasks",
  summary: "Change a task's details, due date, assignee or status.",
  description:
    `Update a task. Only the fields you send change. Same rules as ${BRAND_NAME}: the new assignee must be visible to this person. ` +
    "Ask the user to confirm before calling.",
  group: "Tasks",
  kind: "write",
  capability: "update",
  idempotent: false,
  inputSchema: updateTaskInput,
  outputFields: ["id", "updated"],
  async handler(context, input) {
    const current = await fetchTask(context, input.id);
    const pickText = (key: "subject" | "priority" | "due_date" | "type" | "status") =>
      input[key] !== undefined ? String(input[key]) : String(current[key] ?? "");

    const parsed = updateTaskSchema.safeParse({
      id: input.id,
      subject: pickText("subject"),
      description: input.description !== undefined ? (input.description ?? "") : String(current.description ?? ""),
      priority: pickText("priority"),
      due_date: pickText("due_date"),
      assigned_to: input.assignee_id ?? String(current.assigned_to ?? ""),
      type: pickText("type"),
      status: pickText("status"),
    });
    if (!parsed.success) throw invalidInput(fieldErrorsMessage(getFieldErrors(parsed.error)));

    const id = unwrapDomainResult(await updateTask(context.supabase, context.actor, parsed.data), "forbidden");
    return { data: { id, updated: true }, recordIds: [input.id] };
  },
};

// ---------------------------------------------------------------------
// complete_task
// ---------------------------------------------------------------------

const completeTaskInput = z.object({ id: recordId("id") });

export const completeTaskTool: McpToolDefinition<z.infer<typeof completeTaskInput>> = {
  name: "complete_task",
  label: "Complete tasks",
  summary: "Mark a task as done.",
  description: "Mark a task as Completed. Completing an already-completed task is harmless. Ask the user to confirm before calling.",
  group: "Tasks",
  kind: "write",
  capability: "update",
  idempotent: false,
  inputSchema: completeTaskInput,
  outputFields: ["id", "completed"],
  async handler(context, input) {
    const id = unwrapDomainResult(await completeTask(context.supabase, context.actor, input.id), "forbidden");
    return { data: { id, completed: true }, recordIds: [input.id] };
  },
};
