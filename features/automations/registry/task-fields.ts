import { MAX_DESCRIPTION_LENGTH, MAX_SUBJECT_LENGTH } from "../config/safeguards";
import type { FieldRegistryEntry } from "./fields";

/**
 * WHAT AN UPDATE TASK ACTION MAY SET — and, later, what a Task-triggered
 * condition could read, once one exists (see FieldRegistryEntry's own
 * `writable` note on why those are two separate questions this one
 * shape deliberately keeps distinct).
 *
 * An ALLOWLIST checked against the real `tasks` table
 * (20260911120000_tasks.sql, extended by 20260923120000), not a
 * reflection of it — every entry here is also, independently, one of
 * update_task_via_automation's own SQL parameters; a field appearing
 * here with nothing on the SQL side to receive it would be a config
 * option the backend cannot actually apply, which is exactly what this
 * registry exists to make impossible.
 *
 * DELIBERATELY EXCLUDED: `id`, `customer_id`, `lead_id` (identity —
 * locked by protect_task_identity_columns regardless), `assigned_to`
 * (handled by the shared assignment-mode fields every write action
 * already has, not a plain field), `created_by`/`created_at`/
 * `updated_at` (never automation-writable), `activation_status`
 * (deactivate_task_via_automation's own, narrower job — see its
 * one-way note in the migration).
 */
export const TASK_FIELD_REGISTRY: ReadonlyArray<FieldRegistryEntry> = [
  { key: "subject", label: "Subject", type: "text", writable: true, maxLength: MAX_SUBJECT_LENGTH },
  { key: "description", label: "Description", type: "text", writable: true, maxLength: MAX_DESCRIPTION_LENGTH },
  {
    key: "priority",
    label: "Priority",
    type: "enum",
    writable: true,
    enumOptions: [
      { value: "Low", label: "Low" },
      { value: "Medium", label: "Medium" },
      { value: "High", label: "High" },
    ],
  },
  { key: "due_date", label: "Due date", type: "date", writable: true },
  {
    key: "type",
    label: "Type",
    type: "enum",
    writable: true,
    enumOptions: [
      { value: "Call", label: "Call" },
      { value: "Meeting", label: "Meeting" },
      { value: "Email", label: "Email" },
      { value: "Other", label: "Other" },
    ],
  },
  {
    key: "status",
    label: "Status",
    type: "enum",
    writable: true,
    enumOptions: [
      { value: "Pending", label: "Pending" },
      { value: "Completed", label: "Completed" },
    ],
  },
];

const BY_KEY = new Map(TASK_FIELD_REGISTRY.map((field) => [field.key, field]));

export function getTaskFieldDefinition(key: string): FieldRegistryEntry | undefined {
  return BY_KEY.get(key);
}

export function getWritableTaskFields(): ReadonlyArray<FieldRegistryEntry> {
  return TASK_FIELD_REGISTRY.filter((field) => field.writable);
}
