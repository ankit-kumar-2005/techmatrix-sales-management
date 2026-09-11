import { z } from "zod";
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES, type TaskPriority, type TaskStatus, type TaskType } from "@/types/task";

const SUBJECT_MAX_LENGTH = 200;

/**
 * priority/type are validated via a plain .refine() against their fixed
 * lists rather than z.enum(...) — same reasoning as
 * features/catalog/schemas.ts's pricingUnitSchema: this project is on
 * Zod v4, whose enum error-customization API differs from v3's, and no
 * schema in this codebase uses z.enum yet. A refine() sidesteps guessing
 * at an API surface this project hasn't already exercised.
 */
const taskPrioritySchema = z
  .string()
  .refine((value): value is TaskPriority => (TASK_PRIORITIES as readonly string[]).includes(value), {
    message: "Select a priority.",
  });

const taskTypeSchema = z
  .string()
  .refine((value): value is TaskType => (TASK_TYPES as readonly string[]).includes(value), {
    message: "Select a type.",
  });

/**
 * customer_id and created_by are deliberately not here — both are always
 * derived server-side (see createTaskAction), never trusted from the
 * client, matching createLeadSchema's own reasoning. status isn't here
 * either: a new task always starts Pending, matching the DB default;
 * status only ever changes via completeTaskAction.
 *
 * lead_id and assigned_to are validated only as "a uuid was selected" —
 * WHETHER the caller may actually attach a task to that lead, or assign
 * it to that user, is a hierarchy/visibility question re-checked
 * server-side against the live database (and enforced again by RLS
 * regardless), not something Zod can look up.
 */
export const createTaskSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, "Subject is required.")
    .max(SUBJECT_MAX_LENGTH, `Subject must be ${SUBJECT_MAX_LENGTH} characters or fewer.`),
  description: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  priority: taskPrioritySchema,
  due_date: z.string().trim().min(1, "Due date is required."),
  assigned_to: z.string().trim().min(1, "Select who this is assigned to.").uuid("Select who this is assigned to."),
  lead_id: z.string().trim().min(1, "Select a lead.").uuid("Select a lead."),
  type: taskTypeSchema,
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

// Same .refine() pattern as taskPriority/taskTypeSchema above, for the
// same reason — TASK_STATUSES is the one and only vocabulary (see
// types/task.ts: "There is NO: Active/Inactive/record_status").
const taskStatusSchema = z
  .string()
  .refine((value): value is TaskStatus => (TASK_STATUSES as readonly string[]).includes(value), {
    message: "Select a status.",
  });

/**
 * lead_id is deliberately NOT part of this schema — it's immutable after
 * creation (protect_task_identity_columns, see the tasks migration), so
 * the edit form never submits it; EditTaskDialog shows it as read-only
 * display text instead of the searchable picker createTaskSchema's own
 * lead_id field feeds — same treatment updateContactSchema already gives
 * its own immutable lead_id.
 *
 * status IS here (unlike createTaskSchema, where a new task always
 * starts at the database's own DEFAULT 'Pending') — editing is the one
 * place besides completeTaskAction a task's status can change, per the
 * spec's own "Pre-populate: ... Status" requirement. Still only ever
 * "Pending" or "Completed" — see taskStatusSchema above.
 */
export const updateTaskSchema = z.object({
  id: z.string().trim().min(1).uuid(),
  subject: createTaskSchema.shape.subject,
  description: createTaskSchema.shape.description,
  priority: taskPrioritySchema,
  due_date: createTaskSchema.shape.due_date,
  assigned_to: createTaskSchema.shape.assigned_to,
  type: taskTypeSchema,
  status: taskStatusSchema,
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
