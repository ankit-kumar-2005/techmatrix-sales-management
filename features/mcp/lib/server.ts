import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BRAND_NAME } from "@/lib/brand";
import { toMcpToolDescriptor } from "../registry/index";
import { listVisibleTools } from "./access";
import { handleToolCall, type McpSession } from "./handle-call";

/**
 * One MCP server per HTTP request (stateless Streamable HTTP). Built
 * around the low-level SDK Server rather than McpServer.registerTool so
 * that tools/list can be computed per person from live data — the set of
 * tools differs by company settings and role, and must never be a list
 * fixed at module load.
 */
export function buildMcpServer(session: McpSession): Server {
  const instructions = session.access.ok
    ? `You are connected to ${BRAND_NAME} as ${session.access.context.user_name ?? "this user"} at ` +
      `${session.access.context.company_name ?? "their company"}. You can see and change only what this person can in ${BRAND_NAME}. ` +
      "Search before you create to avoid duplicates, and confirm with the user before any change."
    : session.access.message;

  const server = new Server(
    { name: `${BRAND_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-mcp`, title: BRAND_NAME, version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } }, instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: session.access.ok ? listVisibleTools(session.access.context).map(toMcpToolDescriptor) : [],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(session, request.params.name, request.params.arguments),
  );

  return server;
}
