import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from "@/types/task";
import type { FilterSpec } from "./filters";

/**
 * FIELD ALLOWLISTS PER OBJECT — what a search may filter/sort on, which
 * columns a read may SELECT, and which keys a response may contain.
 *
 * Every column listed here is one the app's own pages already read for
 * the same person (getLeadsForCustomer, getTasksBucketPage,
 * getContactsPage). Deliberately never exposed, anywhere in MCP:
 *   customer_id          the tenant boundary itself
 *   external_source_id,  Lead Capture plumbing
 *   notes
 *   created_by           auth user ids
 *   anything from customer_integrations, automation tables, invitations,
 *   tokens or auth — no tool reads those tables at all.
 */

// ---------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------

export const LEAD_SELECT =
  "id, company, contact_name, email, phone, whatsapp_phone, address, deal_value, stage_id, owner_id, source, next_step, status, closed_at, expected_close_date, created_at, updated_at";

export const LEAD_FILTERS: FilterSpec = {
  fields: {
    id: { column: "id", type: "uuid", description: "the lead's id" },
    company: { column: "company", type: "text", description: "company name" },
    contact_name: { column: "contact_name", type: "text", description: "the person's name" },
    email: { column: "email", type: "text", description: "email address" },
    phone: { column: "phone", type: "text", description: "phone number" },
    deal_value: { column: "deal_value", type: "number", description: "deal value in INR" },
    stage: { column: "stage_id", type: "enum", special: "stage_name", description: "pipeline stage name, e.g. Qualified" },
    is_closed: { column: "closed_at", type: "boolean", special: "closed_flag", description: "true for won/lost (closed) leads" },
    source: { column: "source", type: "text", description: "where the lead came from" },
    status: { column: "status", type: "enum", options: ["Active", "Inactive"], description: "record status" },
    next_step: { column: "next_step", type: "text", description: "the planned next step" },
    expected_close_date: { column: "expected_close_date", type: "date", description: "expected close date" },
    created_at: { column: "created_at", type: "date", description: "date the lead was created" },
    updated_at: { column: "updated_at", type: "date", description: "date the lead was last changed" },
  },
  sortable: {
    updated_at: "updated_at",
    created_at: "created_at",
    deal_value: "deal_value",
    expected_close_date: "expected_close_date",
    company: "company",
    contact_name: "contact_name",
  },
  defaultSort: { column: "updated_at", ascending: false },
};

export const LEAD_OUTPUT_FIELDS = [
  "id",
  "company",
  "contact_name",
  "email",
  "phone",
  "whatsapp_phone",
  "address",
  "deal_value",
  "deal_value_formatted",
  "stage",
  "stage_id",
  "is_closed",
  "is_won",
  "owner_id",
  "owner_name",
  "source",
  "next_step",
  "status",
  "closed_at",
  "expected_close_date",
  "created_at",
  "updated_at",
] as const;

// ---------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------

export const TASK_SELECT = "id, lead_id, subject, description, priority, due_date, assigned_to, type, status, created_at, updated_at";

export const TASK_FILTERS: FilterSpec = {
  fields: {
    id: { column: "id", type: "uuid", description: "the task's id" },
    subject: { column: "subject", type: "text", description: "the task's subject" },
    status: { column: "status", type: "enum", options: TASK_STATUSES, description: "Pending or Completed" },
    priority: { column: "priority", type: "enum", options: TASK_PRIORITIES, description: "priority" },
    type: { column: "type", type: "enum", options: TASK_TYPES, description: "kind of task" },
    due_date: { column: "due_date", type: "date", description: "due date" },
    lead_id: { column: "lead_id", type: "uuid", description: "the lead the task belongs to" },
    created_at: { column: "created_at", type: "date", description: "date the task was created" },
  },
  sortable: { due_date: "due_date", created_at: "created_at", updated_at: "updated_at", priority: "priority" },
  defaultSort: { column: "due_date", ascending: true },
};

export const TASK_OUTPUT_FIELDS = [
  "id",
  "subject",
  "description",
  "priority",
  "due_date",
  "type",
  "status",
  "lead_id",
  "lead_label",
  "assignee_id",
  "assignee_name",
  "created_at",
  "updated_at",
] as const;

// ---------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------

export const CONTACT_SELECT = "id, lead_id, owner_id, name, company, title, email, phone, tags, created_at, updated_at";

export const CONTACT_FILTERS: FilterSpec = {
  fields: {
    id: { column: "id", type: "uuid", description: "the contact's id" },
    name: { column: "name", type: "text", description: "the contact's name" },
    company: { column: "company", type: "text", description: "company" },
    title: { column: "title", type: "text", description: "job title" },
    email: { column: "email", type: "text", description: "email address" },
    phone: { column: "phone", type: "text", description: "phone number" },
    lead_id: { column: "lead_id", type: "uuid", description: "the lead the contact belongs to" },
    created_at: { column: "created_at", type: "date", description: "date the contact was created" },
  },
  sortable: { name: "name", company: "company", created_at: "created_at", updated_at: "updated_at" },
  defaultSort: { column: "updated_at", ascending: false },
};

export const CONTACT_OUTPUT_FIELDS = [
  "id",
  "name",
  "company",
  "title",
  "email",
  "phone",
  "tags",
  "lead_id",
  "lead_label",
  "owner_id",
  "owner_name",
  "created_at",
  "updated_at",
] as const;

/** Identity-shaped argument names. No tool accepts any of them (they are
 *  stripped by Zod); they are the ONLY names outside a tool's own
 *  parameters that the audit log records, so admins can see attempts to
 *  pass identity through a tool call. */
export const IDENTITY_ARGUMENT_NAMES: readonly string[] = [
  "customer_id",
  "customer_user_id",
  "company_id",
  "tenant_id",
  "owner_id",
  "user_id",
  "role",
  "permission",
  "permissions",
];

/** Keys that must never appear anywhere in an MCP response, at any depth.
 *  A last-resort net under the explicit projections — if one of these
 *  ever shows up, it is stripped and logged as a bug. */
export const FORBIDDEN_OUTPUT_KEYS: readonly string[] = [
  "customer_id",
  "webhook_token",
  "worker_token",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "client_secret",
  "password",
  "api_key",
  "created_by",
  "external_source_id",
];
