import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enforceOutputAllowlist, projectContact, projectLead, projectTask } from "../lib/output";
import {
  CONTACT_OUTPUT_FIELDS,
  CONTACT_SELECT,
  FORBIDDEN_OUTPUT_KEYS,
  IDENTITY_ARGUMENT_NAMES,
  LEAD_OUTPUT_FIELDS,
  LEAD_SELECT,
  TASK_OUTPUT_FIELDS,
  TASK_SELECT,
} from "./fields";
import { MCP_TOOLS, defaultToolEnabled, toMcpToolDescriptor, toolParameterNames } from "./index";

/**
 * Registry-wide invariants. If any of these fail, a tool or field list
 * was added without the safety properties every tool must have.
 */

const IDENTITY_ARGUMENTS = ["customer_id", "customer_user_id", "owner_id", "user_id", "role", "permission", "permissions"];

describe("the tool registry", () => {
  it("has unique, well-formed names and plain-language labels", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    for (const tool of MCP_TOOLS) {
      assert.match(tool.name, /^[a-z][a-z_]{0,62}$/);
      assert.ok(tool.label.length > 0 && tool.summary.length > 0 && tool.description.length > 0, tool.name);
    }
  });

  it("contains no delete tools", () => {
    for (const tool of MCP_TOOLS) assert.doesNotMatch(tool.name, /delete|remove|destroy|purge/);
  });

  it("matches the v1 catalog", () => {
    assert.deepEqual(MCP_TOOLS.map((tool) => tool.name).sort(), [
      "complete_task",
      "create_contact",
      "create_lead",
      "create_task",
      "get_contact",
      "get_lead",
      "get_pipeline_summary",
      "get_task",
      "search_contacts",
      "search_leads",
      "search_tasks",
      "update_contact",
      "update_lead",
      "update_task",
    ]);
  });

  it("enables read tools and disables write tools by default", () => {
    for (const tool of MCP_TOOLS) assert.equal(defaultToolEnabled(tool), tool.kind === "read", tool.name);
  });

  it("annotates writes so clients ask before acting, and reads as read-only", () => {
    for (const tool of MCP_TOOLS) {
      const { annotations } = toMcpToolDescriptor(tool);
      assert.equal(annotations.readOnlyHint, tool.kind === "read", tool.name);
      if (tool.kind === "write") assert.equal(annotations.idempotentHint, false, tool.name);
      assert.equal(annotations.openWorldHint, false);
    }
  });

  it("produces an object JSON Schema for every tool, with no identity arguments", () => {
    for (const tool of MCP_TOOLS) {
      const { inputSchema } = toMcpToolDescriptor(tool);
      assert.equal(inputSchema.type, "object", tool.name);
      const properties = Object.keys((inputSchema as { properties?: object }).properties ?? {});
      for (const forbidden of IDENTITY_ARGUMENTS) assert.ok(!properties.includes(forbidden), `${tool.name} accepts ${forbidden}`);
    }
  });

  it("strips identity arguments a client sends anyway", () => {
    for (const tool of MCP_TOOLS) {
      const parsed = tool.inputSchema.safeParse({ customer_id: "x", owner_id: "y", role: "ADMIN" });
      if (parsed.success) {
        for (const forbidden of IDENTITY_ARGUMENTS) assert.ok(!(forbidden in (parsed.data as object)), tool.name);
      }
    }
  });

  it("every idempotent tool names the table its replays are re-read from", () => {
    for (const tool of MCP_TOOLS) {
      if (tool.idempotent) assert.ok(tool.replayTable, `${tool.name} has no replayTable`);
      else assert.equal(tool.replayTable, undefined, tool.name);
    }
  });

  it("every tool's input is an object schema, so its parameter names can be allowlisted for the audit log", () => {
    for (const tool of MCP_TOOLS) {
      const names = toolParameterNames(tool);
      assert.ok(names.length > 0 || tool.name === "get_pipeline_summary", tool.name);
      for (const identity of IDENTITY_ARGUMENT_NAMES) assert.ok(!names.includes(identity), `${tool.name} declares ${identity}`);
    }
  });

  it("only create tools are idempotent, and they accept an idempotency_key", () => {
    for (const tool of MCP_TOOLS) {
      assert.equal(tool.idempotent, tool.capability === "create", tool.name);
      const properties = Object.keys((toMcpToolDescriptor(tool).inputSchema as { properties?: object }).properties ?? {});
      assert.equal(properties.includes("idempotency_key"), tool.idempotent, tool.name);
    }
  });
});

describe("output allowlists", () => {
  it("never name a forbidden key, at the tool level or the object level", () => {
    const lists = [LEAD_OUTPUT_FIELDS, TASK_OUTPUT_FIELDS, CONTACT_OUTPUT_FIELDS, ...MCP_TOOLS.map((t) => t.outputFields)];
    for (const list of lists) for (const key of list) assert.ok(!FORBIDDEN_OUTPUT_KEYS.includes(key), key);
  });

  it("never SELECT a forbidden column", () => {
    for (const select of [LEAD_SELECT, TASK_SELECT, CONTACT_SELECT]) {
      const columns = select.split(",").map((column) => column.trim());
      for (const column of columns) assert.ok(!FORBIDDEN_OUTPUT_KEYS.includes(column), column);
    }
  });

  it("projections drop every column that is not allowlisted", () => {
    const hostileRow = {
      id: "l1",
      customer_id: "cust-a",
      webhook_token: "secret-token",
      external_source_id: "im-1",
      created_by: "auth-1",
      notes: "buyer text",
      contact_name: "Priya",
      deal_value: "18000",
      stage_id: "s1",
      owner_id: "cu-1",
      assigned_to: "cu-1",
      lead_id: "l1",
      tags: ["a"],
    };
    for (const projected of [projectLead(hostileRow, {}), projectTask(hostileRow, {}), projectContact(hostileRow, {})]) {
      const serialized = JSON.stringify(projected);
      for (const leaked of ["customer_id", "secret-token", "im-1", "auth-1", "buyer text"]) {
        assert.ok(!serialized.includes(leaked), leaked);
      }
    }
    assert.deepEqual(Object.keys(projectLead(hostileRow, {})).sort(), [...LEAD_OUTPUT_FIELDS].sort());
  });

  it("formats money as a number plus INR text", () => {
    const lead = projectLead({ id: "l1", deal_value: "18000" }, {});
    assert.equal(lead.deal_value, 18000);
    assert.equal(lead.deal_value_formatted, "₹18,000");
  });

  it("enforceOutputAllowlist removes unlisted top-level keys and forbidden keys at any depth", () => {
    const { data, stripped } = enforceOutputAllowlist(
      { leads: [{ id: "1", nested: { webhook_token: "t", ok: true } }], customer_id: "x", extra: 1 },
      ["leads", "customer_id"],
    );
    assert.deepEqual(data, { leads: [{ id: "1", nested: { ok: true } }] });
    assert.ok(stripped.includes("extra"));
    assert.ok(stripped.some((path) => path.endsWith("webhook_token")));
  });
});
