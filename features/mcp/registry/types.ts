import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import type { CustomerRole, DomainActor } from "@/types/customer";

/** What the registry, the tool listing, the call handler and the admin
 *  UI all read. One definition per tool, in registry/tools/*.ts. */

export type McpToolKind = "read" | "write";
export type McpToolCapability = "read" | "create" | "update";
export type McpToolGroup = "Leads" | "Tasks" | "Contacts" | "Pipeline";
export type McpReplayTable = "leads" | "tasks" | "contacts";

/** Everything a tool handler may use. The Supabase client is authenticated
 *  as the calling person (their own OAuth access token) — there is no
 *  other client in reach. */
export type McpToolContext = {
  supabase: SupabaseClient;
  actor: DomainActor;
  /** Schedules work after the response is sent (Next.js after()). Used for
   *  the same automation drain nudge the UI's own lead creation fires. */
  afterResponse: (task: () => Promise<void>) => void;
};

export type McpToolResult = {
  /** Already reduced to the tool's output allowlist. */
  data: Record<string, unknown>;
  /** Record ids this call read or wrote, for the audit log. */
  recordIds: string[];
};

export type McpToolDefinition<Input = unknown> = {
  /** Stable, snake_case; also the customer_mcp_tools.tool_name value. */
  name: string;
  /** Plain-language label for the admin UI. */
  label: string;
  /** One line for the admin UI. */
  summary: string;
  /** What Claude reads to decide when and how to call the tool. */
  description: string;
  group: McpToolGroup;
  kind: McpToolKind;
  capability: McpToolCapability;
  /** Lowest role allowed to call it, on top of RLS. Undefined = every role
   *  (RLS and the domain services still decide row by row). */
  minRole?: CustomerRole;
  /** Create tools accept an idempotency_key. */
  idempotent: boolean;
  /** For idempotent tools: where a replayed record id is re-read through
   *  RLS before it is returned. Required when idempotent is true. */
  replayTable?: McpReplayTable;
  inputSchema: z.ZodType<Input>;
  /** Top-level keys a successful response may contain. Enforced at
   *  runtime by enforceOutputAllowlist and asserted by registry tests. */
  outputFields: readonly string[];
  handler: (context: McpToolContext, input: Input) => Promise<McpToolResult>;
};

/** Roles from least to most privileged. */
export const ROLE_RANK: Record<CustomerRole, number> = {
  SALES_REP: 1,
  SENIOR_SALES_REP: 2,
  MANAGER: 3,
  ADMIN: 4,
};
