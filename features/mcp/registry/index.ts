import { z } from "zod";
import { createContactTool, getContact, searchContacts, updateContactTool } from "./tools/contacts";
import { createLeadTool, getLead, searchLeads, updateLeadTool } from "./tools/leads";
import { getPipelineSummary } from "./tools/pipeline";
import { completeTaskTool, createTaskTool, getTask, searchTasks, updateTaskTool } from "./tools/tasks";
import type { McpToolDefinition, McpToolGroup } from "./types";

/**
 * THE MCP TOOL REGISTRY — the only list of tools that exists.
 *
 * tools/list, tools/call, the admin capability catalog and the consent
 * screen all read this array; nothing else names a tool. There are no
 * delete tools: records are deactivated or completed, never deleted,
 * exactly like the UI.
 */
export const MCP_TOOLS: readonly McpToolDefinition<unknown>[] = [
  searchLeads,
  getLead,
  createLeadTool,
  updateLeadTool,
  searchTasks,
  getTask,
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  searchContacts,
  getContact,
  createContactTool,
  updateContactTool,
  getPipelineSummary,
] as unknown as readonly McpToolDefinition<unknown>[];

export const MCP_TOOL_GROUPS: readonly McpToolGroup[] = ["Leads", "Tasks", "Contacts", "Pipeline"];

const BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

export function getMcpTool(name: string): McpToolDefinition<unknown> | undefined {
  return BY_NAME.get(name);
}

export function isRegisteredToolName(name: string): boolean {
  return BY_NAME.has(name);
}

/** The tool's own top-level parameter names, read from its Zod object
 *  schema — the allowlist for audit parameter names. */
export function toolParameterNames(tool: McpToolDefinition<unknown> | undefined): string[] {
  const schema = tool?.inputSchema;
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

/** Read tools are on by default once a company turns MCP on; write tools
 *  are off until an admin enables "Allow changes" AND the tool. */
export function defaultToolEnabled(tool: Pick<McpToolDefinition, "kind">): boolean {
  return tool.kind === "read";
}

/** MCP annotations so clients (Claude) ask the user before a write. */
export function toolAnnotations(tool: McpToolDefinition<unknown>) {
  return {
    title: tool.label,
    readOnlyHint: tool.kind === "read",
    destructiveHint: tool.kind === "write" && tool.capability === "update",
    idempotentHint: tool.kind === "read",
    openWorldHint: false,
  };
}

/** The tool as tools/list returns it. */
export function toMcpToolDescriptor(tool: McpToolDefinition<unknown>) {
  const jsonSchema = z.toJSONSchema(tool.inputSchema as z.ZodType, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete jsonSchema.$schema;
  return {
    name: tool.name,
    title: tool.label,
    description: tool.description,
    inputSchema: { ...jsonSchema, type: "object" as const },
    annotations: toolAnnotations(tool),
  };
}
