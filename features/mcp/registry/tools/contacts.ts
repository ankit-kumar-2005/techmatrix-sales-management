import { z } from "zod";
import { BRAND_NAME } from "@/lib/brand";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { createContactSchema, updateContactSchema } from "@/features/contacts/schemas";
import { createContact, updateContact } from "@/features/contacts/lib/contact-service";
import { MCP_DEFAULT_RESULTS_PER_CALL } from "../../config/limits";
import { invalidInput, notFound } from "../../lib/errors";
import { projectContact } from "../../lib/output";
import { applyConditions, applySortAndLimit, searchInputSchema, validateFilters, type FilterableQuery } from "../filters";
import { CONTACT_FILTERS, CONTACT_SELECT } from "../fields";
import type { McpToolDefinition } from "../types";
import {
  assigneeId,
  fieldErrorsMessage,
  idempotencyKey,
  loadLookups,
  readFailed,
  recordId,
  runQuery,
  unwrapDomainResult,
} from "./shared";

// Mirrors createContactSchema's own caps (20 tags, 60 chars each). Commas
// are refused because the form schema splits its tags string on commas.
const tagsInput = z
  .array(z.string().min(1).max(60).regex(/^[^,]+$/, "A tag cannot contain a comma."))
  .max(20)
  .describe("Up to 20 tags.");

// ---------------------------------------------------------------------
// search_contacts
// ---------------------------------------------------------------------

const searchContactsInput = searchInputSchema(CONTACT_FILTERS, {
  owned_by_me: z.boolean().optional().describe("Only contacts you own."),
});

export const searchContacts: McpToolDefinition<z.infer<typeof searchContactsInput>> = {
  name: "search_contacts",
  label: "Search contacts",
  summary: "Find contacts by name, company, title or lead.",
  description: "Search the contacts this person can see. Filter with structured conditions (field, operator, value).",
  group: "Contacts",
  kind: "read",
  capability: "read",
  idempotent: false,
  inputSchema: searchContactsInput,
  outputFields: ["contacts", "returned", "has_more"],
  async handler(context, input) {
    const conditions = validateFilters(CONTACT_FILTERS, input.filters ?? []);
    const limit = input.limit ?? MCP_DEFAULT_RESULTS_PER_CALL;

    let query = context.supabase
      .from("contacts")
      .select(CONTACT_SELECT)
      .eq("customer_id", context.actor.customerId) as unknown as FilterableQuery;
    if (input.owned_by_me) query = query.eq("owner_id", context.actor.customerUserId);
    query = applySortAndLimit(applyConditions(query, conditions), CONTACT_FILTERS, input.sort, limit);

    const { data, error } = await runQuery(query);
    if (error || !Array.isArray(data)) throw readFailed();

    const rows = (data as Record<string, unknown>[]).slice(0, limit);
    const lookups = await loadLookups(context, { people: true, leadIds: rows.map((row) => String(row.lead_id)) });
    return {
      data: { contacts: rows.map((row) => projectContact(row, lookups)), returned: rows.length, has_more: data.length > limit },
      recordIds: rows.map((row) => String(row.id)),
    };
  },
};

// ---------------------------------------------------------------------
// get_contact
// ---------------------------------------------------------------------

async function fetchContact(context: Parameters<McpToolDefinition["handler"]>[0], id: string) {
  const { data, error } = await context.supabase
    .from("contacts")
    .select(CONTACT_SELECT)
    .eq("id", id)
    .eq("customer_id", context.actor.customerId)
    .maybeSingle();
  if (error) throw readFailed();
  if (!data) throw notFound();
  return data as Record<string, unknown>;
}

const getContactInput = z.object({ id: recordId("id") });

export const getContact: McpToolDefinition<z.infer<typeof getContactInput>> = {
  name: "get_contact",
  label: "View a contact",
  summary: "Open one contact.",
  description: "Get one contact by id.",
  group: "Contacts",
  kind: "read",
  capability: "read",
  idempotent: false,
  inputSchema: getContactInput,
  outputFields: ["contact"],
  async handler(context, input) {
    const row = await fetchContact(context, input.id);
    const lookups = await loadLookups(context, { people: true, leadIds: [String(row.lead_id)] });
    return { data: { contact: projectContact(row, lookups) }, recordIds: [input.id] };
  },
};

// ---------------------------------------------------------------------
// create_contact
// ---------------------------------------------------------------------

const createContactInput = z.object({
  name: z.string().min(1).max(200).describe("The contact's name."),
  lead_id: recordId("lead_id").describe("The lead this contact belongs to."),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional().describe("Job title."),
  email: z.string().max(320).optional(),
  phone: z.string().max(40).optional(),
  tags: tagsInput.optional(),
  assignee_id: assigneeId().describe("Owner. Sales Reps always own the contacts they create."),
  idempotency_key: idempotencyKey(),
});

export const createContactTool: McpToolDefinition<z.infer<typeof createContactInput>> = {
  name: "create_contact",
  label: "Create contacts",
  summary: "Add a contact to a lead.",
  description:
    `Create a contact on a lead. Same rules as ${BRAND_NAME}: the owner must be inside this person's team, and Sales Reps always own what they create. ` +
    "Ask the user to confirm before calling.",
  group: "Contacts",
  kind: "write",
  capability: "create",
  idempotent: true,
  replayTable: "contacts",
  inputSchema: createContactInput,
  outputFields: ["id", "created", "replayed"],
  async handler(context, input) {
    const parsed = createContactSchema.safeParse({
      name: input.name,
      company: input.company ?? "",
      title: input.title ?? "",
      email: input.email ?? "",
      phone: input.phone ?? "",
      tags: (input.tags ?? []).join(", "),
      lead_id: input.lead_id,
      owner_id: input.assignee_id ?? context.actor.customerUserId,
    });
    if (!parsed.success) throw invalidInput(fieldErrorsMessage(getFieldErrors(parsed.error)));

    const id = unwrapDomainResult(await createContact(context.supabase, context.actor, parsed.data), "forbidden");
    return { data: { id, created: true }, recordIds: id ? [id] : [] };
  },
};

// ---------------------------------------------------------------------
// update_contact
// ---------------------------------------------------------------------

const updateContactInput = z.object({
  id: recordId("id"),
  name: z.string().min(1).max(200).optional(),
  company: z.string().max(200).nullable().optional().describe("Send null to clear."),
  title: z.string().max(200).nullable().optional().describe("Send null to clear."),
  email: z.string().max(320).nullable().optional().describe("Send null to clear."),
  phone: z.string().max(40).nullable().optional().describe("Send null to clear."),
  tags: tagsInput.optional().describe("Replaces all tags."),
  assignee_id: assigneeId().describe("New owner."),
});

export const updateContactTool: McpToolDefinition<z.infer<typeof updateContactInput>> = {
  name: "update_contact",
  label: "Update contacts",
  summary: "Change a contact's details or owner.",
  description: `Update a contact. Only the fields you send change. Same rules as ${BRAND_NAME}. Ask the user to confirm before calling.`,
  group: "Contacts",
  kind: "write",
  capability: "update",
  idempotent: false,
  inputSchema: updateContactInput,
  outputFields: ["id", "updated"],
  async handler(context, input) {
    const current = await fetchContact(context, input.id);
    const pickText = (key: "name" | "company" | "title" | "email" | "phone") =>
      input[key] !== undefined ? (input[key] ?? "") : String(current[key] ?? "");
    const currentTags = Array.isArray(current.tags) ? (current.tags as string[]) : [];

    const parsed = updateContactSchema.safeParse({
      id: input.id,
      name: pickText("name"),
      company: pickText("company"),
      title: pickText("title"),
      email: pickText("email"),
      phone: pickText("phone"),
      tags: (input.tags ?? currentTags).join(", "),
      owner_id: input.assignee_id ?? String(current.owner_id ?? ""),
    });
    if (!parsed.success) throw invalidInput(fieldErrorsMessage(getFieldErrors(parsed.error)));

    const id = unwrapDomainResult(await updateContact(context.supabase, context.actor, parsed.data), "forbidden");
    return { data: { id, updated: true }, recordIds: [input.id] };
  },
};
