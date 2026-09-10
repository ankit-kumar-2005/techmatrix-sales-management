/** Fixed vocabulary, CHECK-constrained in the database — not
 *  customer-configurable the way lead stages are, so a plain union (not
 *  a lookup table) is the right shape here, same reasoning as
 *  types/catalog.ts's PricingUnit. */
export const TASK_PRIORITIES = ["Low", "Medium", "High"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_TYPES = ["Call", "Meeting", "Email", "Other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = ["Pending", "Completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A row from public.tasks. Always linked to a Lead — there is no
 *  standalone-task shape in this app. */
export type Task = {
  id: string;
  customer_id: string;
  lead_id: string;
  subject: string;
  description: string | null;
  priority: TaskPriority;
  /** date (not timestamptz) — a due date is a calendar day, not a point
   *  in time. "YYYY-MM-DD". */
  due_date: string;
  assigned_to: string;
  type: TaskType;
  status: TaskStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
