import { z } from "zod";
import { BRAND_NAME } from "@/lib/brand";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { drainAutomationQueue } from "@/features/automations/lib/drain";
import { createLeadSchema, updateLeadSchema } from "@/features/leads/schemas";
import { createLead, updateLead } from "@/features/leads/lib/lead-service";
import { getContactsForLead } from "@/features/contacts/lib/get-contacts";
import { getTasksForLead } from "@/features/tasks/lib/get-tasks";
import { MCP_DEFAULT_RESULTS_PER_CALL, MCP_MAX_RELATED_RECORDS } from "../../config/limits";
import { invalidInput, notFound } from "../../lib/errors";
import { projectContact, projectLead, projectTask } from "../../lib/output";
import { applyConditions, applySortAndLimit, searchInputSchema, validateFilters, type FilterableQuery } from "../filters";
import { LEAD_FILTERS, LEAD_SELECT } from "../fields";
import type { McpToolDefinition } from "../types";
import {
  assigneeId,
  defaultStage,
  fieldErrorsMessage,
  findStageByName,
  idempotencyKey,
  isoDate,
  loadLookups,
  readFailed,
  recordId,
  runQuery,
  unknownStage,
  unwrapDomainResult,
} from "./shared";

// ---------------------------------------------------------------------
// search_leads
// ---------------------------------------------------------------------

const searchLeadsInput = searchInputSchema(LEAD_FILTERS, {
  owned_by_me: z.boolean().optional().describe("Only leads you own."),
});

export const searchLeads: McpToolDefinition<z.infer<typeof searchLeadsInput>> = {
  name: "search_leads",
  label: "Search leads",
  summary: "Find leads by stage, value, source, dates and more.",
  description:
    "Search the leads this person can see in the pipeline. Filter with structured conditions (field, operator, value); " +
    "stage filters take the company's own stage names. Returns up to the requested limit, most recently updated first unless sorted. " +
    "Money is returned as a number plus an INR-formatted string.",
  group: "Leads",
  kind: "read",
  capability: "read",
  idempotent: false,
  inputSchema: searchLeadsInput,
  outputFields: ["leads", "returned", "has_more"],
  async handler(context, input) {
    const conditions = validateFilters(LEAD_FILTERS, input.filters ?? []);
    const limit = input.limit ?? MCP_DEFAULT_RESULTS_PER_CALL;
    const lookups = await loadLookups(context, { stages: true, people: true });

    let query = context.supabase
      .from("leads")
      .select(LEAD_SELECT)
      .eq("customer_id", context.actor.customerId) as unknown as FilterableQuery;
    if (input.owned_by_me) query = query.eq("owner_id", context.actor.customerUserId);
    query = applyConditions(query, conditions, {
      stageIdByName: (name) => findStageByName(lookups.stages, name)?.id ?? null,
      stageNames: () => lookups.stages.filter((stage) => stage.status === "Active").map((stage) => stage.stage),
    });
    query = applySortAndLimit(query, LEAD_FILTERS, input.sort, limit);

    const { data, error } = await runQuery(query);
    if (error || !Array.isArray(data)) throw readFailed();

    const rows = (data as Record<string, unknown>[]).slice(0, limit);
    return {
      data: { leads: rows.map((row) => projectLead(row, lookups)), returned: rows.length, has_more: data.length > limit },
      recordIds: rows.map((row) => String(row.id)),
    };
  },
};

// ---------------------------------------------------------------------
// get_lead
// ---------------------------------------------------------------------

const getLeadInput = z.object({
  id: recordId("id"),
  include_related: z.boolean().optional().describe("Also return the lead's tasks and contacts that you can see."),
});

export const getLead: McpToolDefinition<z.infer<typeof getLeadInput>> = {
  name: "get_lead",
  label: "View a lead",
  summary: "Open one lead, optionally with its tasks and contacts.",
  description: "Get one lead by id. With include_related, also returns the tasks and contacts on that lead that this person can see.",
  group: "Leads",
  kind: "read",
  capability: "read",
  idempotent: false,
  inputSchema: getLeadInput,
  outputFields: ["lead", "tasks", "contacts"],
  async handler(context, input) {
    const { supabase, actor } = context;
    const { data: row, error } = await supabase
      .from("leads")
      .select(LEAD_SELECT)
      .eq("id", input.id)
      .eq("customer_id", actor.customerId)
      .maybeSingle();
    if (error) throw readFailed();
    if (!row) throw notFound();

    const lookups = await loadLookups(context, { stages: true, people: true, leadIds: [input.id] });
    const result: Record<string, unknown> = { lead: projectLead(row as Record<string, unknown>, lookups) };
    const recordIds = [input.id];

    if (input.include_related) {
      const [contacts, tasks] = await Promise.all([
        getContactsForLead(supabase, actor.customerId, input.id),
        getTasksForLead(supabase, actor.customerId, input.id),
      ]);
      const boundedContacts = contacts.slice(0, MCP_MAX_RELATED_RECORDS);
      const boundedTasks = tasks.slice(0, MCP_MAX_RELATED_RECORDS);
      result.contacts = boundedContacts.map((contact) => projectContact(contact as unknown as Record<string, unknown>, lookups));
      result.tasks = boundedTasks.map((task) => projectTask(task as unknown as Record<string, unknown>, lookups));
      recordIds.push(...boundedContacts.map((c) => c.id), ...boundedTasks.map((t) => t.id));
    }

    return { data: result, recordIds };
  },
};

// ---------------------------------------------------------------------
// create_lead
// ---------------------------------------------------------------------

const optionalText = (description: string) => z.string().max(500).optional().describe(description);

const createLeadInput = z.object({
  contact_name: z.string().min(1).max(200).describe("The person's name."),
  phone: z.string().min(1).max(40).describe("Contact number (7–15 digits)."),
  company: optionalText("Company name."),
  email: optionalText("Email address."),
  whatsapp_phone: optionalText("WhatsApp number, if different from the phone."),
  address: optionalText("Postal address."),
  deal_value: z.number().min(0).optional().describe("Deal value in INR."),
  expected_close_date: isoDate("expected_close_date").optional().describe("YYYY-MM-DD."),
  stage: z.string().max(60).optional().describe("Stage name. Defaults to the first stage of the pipeline."),
  source: optionalText("Where the lead came from, e.g. Referral."),
  next_step: optionalText("The planned next step."),
  assignee_id: assigneeId().describe("Owner. Only administrators can assign a lead to someone else; for everyone else it is always you."),
  idempotency_key: idempotencyKey(),
});

export const createLeadTool: McpToolDefinition<z.infer<typeof createLeadInput>> = {
  name: "create_lead",
  label: "Create leads",
  summary: "Add a new lead to the pipeline.",
  description:
    `Create a lead. Uses the same validation and permissions as the ${BRAND_NAME} form: phone is required, the stage must be active, ` +
    "and only administrators may assign the lead to someone else. Ask the user to confirm before calling.",
  group: "Leads",
  kind: "write",
  capability: "create",
  idempotent: true,
  replayTable: "leads",
  inputSchema: createLeadInput,
  outputFields: ["id", "created", "replayed"],
  async handler(context, input) {
    const { stages } = await loadLookups(context, { stages: true });
    const stage = input.stage ? findStageByName(stages, input.stage) : defaultStage(stages);
    if (!stage) throw input.stage ? unknownStage(stages) : invalidInput("Your company has no active stage to add a lead to.");

    const parsed = createLeadSchema.safeParse({
      contact_name: input.contact_name,
      phone: input.phone,
      company: input.company ?? "",
      email: input.email ?? "",
      whatsapp_phone: input.whatsapp_phone ?? "",
      address: input.address ?? "",
      deal_value: input.deal_value === undefined ? "" : String(input.deal_value),
      expected_close_date: input.expected_close_date ?? "",
      stage_id: stage.id,
      owner_id: input.assignee_id ?? "",
      source: input.source ?? "",
      next_step: input.next_step ?? "",
    });
    if (!parsed.success) throw invalidInput(fieldErrorsMessage(getFieldErrors(parsed.error)));

    const id = unwrapDomainResult(await createLead(context.supabase, context.actor, parsed.data));

    // The same nudge createLeadAction fires; the event itself was already
    // written by the leads AFTER INSERT trigger inside the insert.
    context.afterResponse(() => drainAutomationQueue("a lead was created via MCP"));

    return { data: { id, created: true }, recordIds: id ? [id] : [] };
  },
};

// ---------------------------------------------------------------------
// update_lead
// ---------------------------------------------------------------------

const nullableText = (description: string) => z.string().max(500).nullable().optional().describe(`${description} Send null to clear.`);

const updateLeadInput = z.object({
  id: recordId("id"),
  contact_name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(40).optional(),
  company: nullableText("Company name."),
  email: nullableText("Email address."),
  whatsapp_phone: nullableText("WhatsApp number."),
  address: nullableText("Postal address."),
  deal_value: z.number().min(0).nullable().optional().describe("Deal value in INR. Send null to clear."),
  expected_close_date: isoDate("expected_close_date").nullable().optional().describe("YYYY-MM-DD. Send null to clear."),
  stage: z.string().max(60).optional().describe("Move the lead to this stage (by name)."),
  source: nullableText("Lead source."),
  next_step: nullableText("Next step."),
  assignee_id: assigneeId().describe("New owner. Only administrators can reassign a lead."),
});

const asFormText = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

export const updateLeadTool: McpToolDefinition<z.infer<typeof updateLeadInput>> = {
  name: "update_lead",
  label: "Update leads",
  summary: "Change a lead's details or move it to another stage.",
  description:
    `Update a lead. Only the fields you send change. Same rules as editing in ${BRAND_NAME}: closed leads cannot be edited, ` +
    "only the owner or an administrator may edit, and only administrators may reassign. Ask the user to confirm before calling.",
  group: "Leads",
  kind: "write",
  capability: "update",
  idempotent: false,
  inputSchema: updateLeadInput,
  outputFields: ["id", "updated"],
  async handler(context, input) {
    const { supabase, actor } = context;
    const { data: existing, error } = await supabase
      .from("leads")
      .select("id, company, contact_name, email, phone, whatsapp_phone, address, deal_value, expected_close_date, stage_id, owner_id, source, next_step")
      .eq("id", input.id)
      .eq("customer_id", actor.customerId)
      .maybeSingle();
    if (error) throw readFailed();
    if (!existing) throw notFound();
    const current = existing as Record<string, unknown>;

    let stageId = asFormText(current.stage_id);
    if (input.stage !== undefined) {
      const { stages } = await loadLookups(context, { stages: true });
      const stage = findStageByName(stages, input.stage);
      if (!stage) throw unknownStage(stages);
      stageId = stage.id;
    }

    const merged = (key: keyof typeof input & string) => (input[key] !== undefined ? asFormText(input[key]) : asFormText(current[key]));

    const parsed = updateLeadSchema.safeParse({
      id: input.id,
      contact_name: merged("contact_name"),
      phone: merged("phone"),
      company: merged("company"),
      email: merged("email"),
      whatsapp_phone: merged("whatsapp_phone"),
      address: merged("address"),
      deal_value: merged("deal_value"),
      expected_close_date: merged("expected_close_date"),
      stage_id: stageId,
      // The current owner is carried through unless a new one was sent, so
      // an administrator's edit never silently unassigns the lead.
      owner_id: input.assignee_id ?? asFormText(current.owner_id),
      source: merged("source"),
      next_step: merged("next_step"),
    });
    if (!parsed.success) throw invalidInput(fieldErrorsMessage(getFieldErrors(parsed.error)));

    const id = unwrapDomainResult(await updateLead(supabase, actor, parsed.data));
    return { data: { id, updated: true }, recordIds: [input.id] };
  },
};
