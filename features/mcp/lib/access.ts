import { BRAND_NAME } from "@/lib/brand";
import type { CustomerRole } from "@/types/customer";
import { MCP_TOOLS, defaultToolEnabled, getMcpTool } from "../registry/index";
import { ROLE_RANK, type McpToolDefinition } from "../registry/types";
import type { McpErrorCode } from "./errors";

/**
 * WHO MAY DO WHAT THROUGH MCP — decided per request from LIVE data.
 *
 * McpContext is get_my_mcp_context()'s answer for the token's owner,
 * fetched fresh on every HTTP request (never cached across requests, never
 * read from the token beyond its user id and client id). So a role change,
 * a deactivation, an admin block, a disconnect, or an admin switching a
 * tool off all take effect on the very next call.
 *
 * These functions are pure, so every rule is unit-tested directly
 * (access.test.ts). Tool availability is never authorization: a tool being
 * enabled only lets the call reach the domain/read code, where RLS and the
 * domain services decide row by row as that person.
 */

/** Is the sign-in this token belongs to still alive? (get_my_mcp_context,
 *  design note 9 in the migration.) Only "active" is accepted by MCP. */
export type SessionState = "active" | "ended" | "missing_claim" | "unknown";

export type McpContext = {
  session_state: SessionState;
  customer_id: string;
  customer_user_id: string;
  user_name: string | null;
  company_name: string | null;
  role: CustomerRole;
  mcp_enabled: boolean;
  allow_writes: boolean;
  tool_overrides: Record<string, boolean>;
  person_blocked: boolean;
  /** The caller's own connection for the token's OAuth client. Blocking is
   *  per person (person_blocked), never per connection. */
  connection: { id: string; revoked: boolean; last_used_at: string | null } | null;
};

export type AccessDenial =
  | "unavailable"
  | "session_ended"
  | "session_unverified"
  | "membership_inactive"
  | "mcp_disabled"
  | "connection_blocked"
  | "connection_revoked"
  | "connection_unknown";

/** A denial carries the context when there is one, so the refusal can
 *  still be audited against the person (an admin sees blocked attempts). */
export type AccessDecision =
  | { ok: true; context: McpContext }
  | { ok: false; reason: AccessDenial; message: string; context?: McpContext };

const KNOWN_ROLES: readonly string[] = ["ADMIN", "MANAGER", "SENIOR_SALES_REP", "SALES_REP"];

/** Narrows the RPC's jsonb to McpContext; anything malformed is treated
 *  as "no membership" — a parsing failure can never grant access. */
export function parseMcpContext(raw: unknown): McpContext | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.customer_id !== "string" || typeof value.customer_user_id !== "string") return null;
  if (typeof value.role !== "string" || !KNOWN_ROLES.includes(value.role)) return null;

  const overrides: Record<string, boolean> = {};
  if (value.tool_overrides && typeof value.tool_overrides === "object") {
    for (const [name, enabled] of Object.entries(value.tool_overrides as Record<string, unknown>)) {
      if (typeof enabled === "boolean") overrides[name] = enabled;
    }
  }

  const connection =
    value.connection && typeof value.connection === "object"
      ? (value.connection as Record<string, unknown>)
      : null;

  const sessionStates: readonly string[] = ["active", "ended", "missing_claim", "unknown"];

  return {
    // Anything unrecognised is "unknown", which is refused.
    session_state: (typeof value.session_state === "string" && sessionStates.includes(value.session_state)
      ? value.session_state
      : "unknown") as SessionState,
    customer_id: value.customer_id,
    customer_user_id: value.customer_user_id,
    user_name: typeof value.user_name === "string" ? value.user_name : null,
    company_name: typeof value.company_name === "string" ? value.company_name : null,
    role: value.role as CustomerRole,
    mcp_enabled: value.mcp_enabled === true,
    allow_writes: value.allow_writes === true,
    tool_overrides: overrides,
    // Anything but an explicit false is treated as blocked/revoked.
    person_blocked: value.person_blocked !== false,
    connection:
      connection && typeof connection.id === "string"
        ? {
            id: connection.id,
            revoked: connection.revoked !== false,
            last_used_at: typeof connection.last_used_at === "string" ? connection.last_used_at : null,
          }
        : null,
  };
}

/** Order matters: the most specific, most actionable reason wins. */
export function evaluateAccess(context: McpContext | null): AccessDecision {
  if (!context) {
    return {
      ok: false,
      reason: "membership_inactive",
      message: `Your ${BRAND_NAME} account is not active in any company, so it cannot be used from an AI app.`,
    };
  }
  // The sign-in itself first: a token from a session that was signed out,
  // timed out or belongs to a banned user is refused before anything else.
  if (context.session_state === "ended") {
    return {
      ok: false,
      reason: "session_ended",
      context,
      message: `Your ${BRAND_NAME} sign-in for this app has ended (signed out, expired, or the account was suspended). Reconnect the app to continue.`,
    };
  }
  if (context.session_state !== "active") {
    return {
      ok: false,
      reason: "session_unverified",
      context,
      message: `${BRAND_NAME} could not confirm that your sign-in is still active, so the request was refused. Please try again later or contact your administrator.`,
    };
  }
  if (context.person_blocked) {
    return {
      ok: false,
      reason: "connection_blocked",
      context,
      message: `A ${BRAND_NAME} administrator has blocked AI connections for your account. Contact your administrator.`,
    };
  }
  if (!context.mcp_enabled) {
    const company = context.company_name ?? "your company";
    return {
      ok: false,
      reason: "mcp_disabled",
      context,
      message: `AI connections are turned off for ${company}. Ask a ${BRAND_NAME} administrator to turn them on in Settings → AI Connections.`,
    };
  }
  if (!context.connection) {
    return {
      ok: false,
      reason: "connection_unknown",
      context,
      message: `This AI app was not approved through ${BRAND_NAME}'s consent screen. Remove the connector and add it again.`,
    };
  }
  if (context.connection.revoked) {
    return {
      ok: false,
      reason: "connection_revoked",
      context,
      message: `You disconnected this AI app from ${BRAND_NAME}. Remove the connector and add it again to reconnect.`,
    };
  }
  return { ok: true, context };
}

/** Is this tool switched on for the company (ignoring the person)? */
export function isToolEnabledForCompany(tool: McpToolDefinition<unknown>, context: McpContext): boolean {
  if (!context.mcp_enabled) return false;
  if (tool.kind === "write" && !context.allow_writes) return false;
  return context.tool_overrides[tool.name] ?? defaultToolEnabled(tool);
}

export function roleMeetsMinimum(role: CustomerRole, minRole: CustomerRole | undefined): boolean {
  return !minRole || ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/** What tools/list returns: enabled for the company, and not a tool this
 *  person's role could never call. Re-authorized on every call anyway. */
export function listVisibleTools(context: McpContext): McpToolDefinition<unknown>[] {
  return MCP_TOOLS.filter(
    (tool) => isToolEnabledForCompany(tool, context) && roleMeetsMinimum(context.role, tool.minRole),
  );
}

export type CallDecision =
  | { ok: true; tool: McpToolDefinition<unknown> }
  | { ok: false; code: McpErrorCode; message: string };

/** The call-time check. Never trusts the client's cached tool list. */
export function authorizeToolCall(context: McpContext, toolName: string): CallDecision {
  const tool = getMcpTool(toolName);
  if (!tool) {
    return { ok: false, code: "invalid_input", message: "Unknown tool." };
  }
  if (tool.kind === "write" && !context.allow_writes) {
    return {
      ok: false,
      code: "tool_disabled",
      message: `Making changes through AI apps is turned off for your company. A ${BRAND_NAME} administrator can allow it in Settings → AI Connections.`,
    };
  }
  if (!isToolEnabledForCompany(tool, context)) {
    return { ok: false, code: "tool_disabled", message: `"${tool.label}" is turned off for your company.` };
  }
  if (!roleMeetsMinimum(context.role, tool.minRole)) {
    return { ok: false, code: "forbidden", message: "Your role cannot use this tool." };
  }
  return { ok: true, tool };
}
