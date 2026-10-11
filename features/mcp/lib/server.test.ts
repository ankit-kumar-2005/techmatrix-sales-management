import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createFakeSupabase } from "@/test/fake-supabase";
import { evaluateAccess, type McpContext } from "./access";
import type { McpSession } from "./handle-call";
import { buildMcpServer } from "./server";

/**
 * The real SDK server + Streamable HTTP transport, driven exactly as
 * app/api/mcp/route.ts drives them (stateless, JSON responses), with a
 * fake database behind the session. Proves the protocol wiring: what
 * initialize, tools/list and tools/call actually return on the wire.
 */

const context: McpContext = {
  session_state: "active",
  customer_id: "cust-a",
  customer_user_id: "22222222-2222-4222-8222-222222222222",
  user_name: "Rep",
  company_name: "Company A",
  role: "SALES_REP",
  mcp_enabled: true,
  allow_writes: false,
  tool_overrides: {},
  person_blocked: false,
  connection: { id: "conn-1", revoked: false, last_used_at: null },
};

async function rpc(session: McpSession, body: object) {
  const server = buildMcpServer(session);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  await transport.close();
  await server.close();
  return { status: response.status, json };
}

function session(ctx: McpContext | null): McpSession {
  const { client } = createFakeSupabase(() => ({ data: [], error: null, count: 0 }));
  return {
    userId: "auth-rep",
    clientId: "client-1",
    supabase: client,
    access: evaluateAccess(ctx),
    afterResponse: () => {},
    now: () => new Date(),
  };
}

describe("MCP protocol wiring (stateless Streamable HTTP)", () => {
  it("answers initialize with tool capability and per-person instructions", async () => {
    const { status, json } = await rpc(session(context), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(status, 200);
    const result = json.result as { capabilities: { tools?: unknown }; instructions: string };
    assert.ok(result.capabilities.tools);
    assert.match(result.instructions, /Rep at Company A/);
  });

  it("lists only the tools enabled for this person, each with an object input schema and annotations", async () => {
    const { json } = await rpc(session(context), { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (json.result as { tools: Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }> }).tools;
    assert.ok(tools.length > 0);
    assert.ok(tools.every((tool) => tool.inputSchema.type === "object" && tool.annotations.readOnlyHint === true));
    assert.ok(!tools.some((tool) => tool.name.startsWith("create_")));
  });

  it("lists nothing, and explains why, when access is denied", async () => {
    const off = { ...context, mcp_enabled: false };
    const listed = await rpc(session(off), { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.deepEqual((listed.json.result as { tools: unknown[] }).tools, []);
    const init = await rpc(session(off), {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.match((init.json.result as { instructions: string }).instructions, /turned off/);
  });

  it("runs tools/call in its own request (no session state needed) and returns structured content", async () => {
    const { json } = await rpc(session(context), {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "search_leads", arguments: { limit: 5 } },
    });
    const result = json.result as { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(result.structuredContent, { leads: [], returned: 0, has_more: false });
  });

  it("returns a tool error (not a protocol error) for a disabled write tool", async () => {
    const { json } = await rpc(session(context), {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "create_lead", arguments: { contact_name: "x", phone: "9999999999" } },
    });
    const result = json.result as { isError: boolean; structuredContent: { error: { code: string } } };
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "tool_disabled");
  });
});
