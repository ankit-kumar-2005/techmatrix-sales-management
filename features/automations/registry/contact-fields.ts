import { MAX_CONTACT_NAME_LENGTH, MAX_CONTACT_TEXT_FIELD_LENGTH } from "../config/safeguards";
import type { FieldRegistryEntry } from "./fields";

/**
 * WHAT AN UPDATE CONTACT ACTION MAY SET — see task-fields.ts's identical
 * note on this being an allowlist checked against the real `contacts`
 * table (20260913120000_contacts.sql, extended by 20260923120000), and
 * on `writable` meaning something different from "condition-evaluable"
 * until a Contact-triggered automation exists to read this the other
 * way.
 *
 * DELIBERATELY EXCLUDED: `id`, `customer_id`, `lead_id` (identity —
 * locked by protect_contact_identity_columns regardless), `owner_id`
 * (handled by the shared assignment-mode fields, not a plain field),
 * `created_by`/`created_at`/`updated_at`, `status` (deactivate_contact_
 * via_automation's own job), and `tags` — a stated v1 limitation, not a
 * silent omission: `tags` is a text[] column, and allowlisting an array
 * update needs a real decision (replace the whole array? append?
 * dedupe?) nobody has made yet. Adding it here would mean inventing
 * that decision silently, which is exactly what was asked not to do.
 */
export const CONTACT_FIELD_REGISTRY: ReadonlyArray<FieldRegistryEntry> = [
  { key: "name", label: "Name", type: "text", writable: true, maxLength: MAX_CONTACT_NAME_LENGTH },
  { key: "company", label: "Company", type: "text", writable: true, maxLength: MAX_CONTACT_TEXT_FIELD_LENGTH },
  { key: "title", label: "Title", type: "text", writable: true, maxLength: MAX_CONTACT_TEXT_FIELD_LENGTH },
  { key: "email", label: "Email", type: "text", writable: true, maxLength: MAX_CONTACT_TEXT_FIELD_LENGTH },
  { key: "phone", label: "Phone", type: "text", writable: true, maxLength: MAX_CONTACT_TEXT_FIELD_LENGTH },
];

const BY_KEY = new Map(CONTACT_FIELD_REGISTRY.map((field) => [field.key, field]));

export function getContactFieldDefinition(key: string): FieldRegistryEntry | undefined {
  return BY_KEY.get(key);
}

export function getWritableContactFields(): ReadonlyArray<FieldRegistryEntry> {
  return CONTACT_FIELD_REGISTRY.filter((field) => field.writable);
}
