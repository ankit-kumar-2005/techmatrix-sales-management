import type { SupabaseClient } from "@supabase/supabase-js";
import type { DomainActor } from "@/types/customer";
import { MCP_RATE_LIMIT_MAX_CALLS, MCP_TOOL_TIMEOUT_MS } from "../config/limits";
import { getMcpTool, toolParameterNames } from "../registry/index";
import type { McpToolContext } from "../registry/types";
import { authorizeToolCall, type AccessDecision } from "./access";
import { McpToolError, type McpErrorCode } from "./errors";
import { enforceOutputAllowlist } from "./output";
import {
  auditFieldNames,
  countRecentCalls,
  reserveIdempotencyKey,
  settleIdempotencyKey,
  touchConnection,
  verifyReplayRecord,
  writeAudit,
  type AuditStatus,
} from "./persistence";

/**
 * One MCP request's identity and live access state. Built per HTTP
 * request by createMcpSession (session.ts) from the VERIFIED token and a
 * fresh get_my_mcp_context() read — never reused across requests.
 */
export type McpSession = {
  userId: string;
  clientId: string;
  supabase: SupabaseClient;
  access: AccessDecision;
  afterResponse: McpToolContext["afterResponse"];
  now: () => Date;
};

/** The MCP CallToolResult shape. */
export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function success(data: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function failure(code: McpErrorCode, message: string): ToolCallResult {
  const body = { error: { code, message } };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

function auditStatusFor(code: McpErrorCode): AuditStatus {
  switch (code) {
    case "invalid_input":
      return "invalid";
    case "rate_limited":
      return "rate_limited";
    case "not_found":
    case "forbidden":
    case "tool_disabled":
    case "access_denied":
      return "denied";
    default:
      return "error";
  }
}

function zodIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  // Paths and Zod's own messages only — never the submitted values.
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new McpToolError("timeout", "The request took too long. If it was a change, check before retrying.")),
      MCP_TOOL_TIMEOUT_MS,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function handleToolCall(session: McpSession, toolName: string, rawArguments: unknown): Promise<ToolCallResult> {
  const started = Date.now();
  const fieldNames = auditFieldNames(rawArguments, toolParameterNames(getMcpTool(toolName)));

  // 1. Live access: membership, company switch, block, disconnect. The
  //    refusal is audited when there is a person to attribute it to; with
  //    no active membership there is no one (and RLS would refuse the row).
  if (!session.access.ok) {
    const denied = session.access.context;
    if (denied) {
      await writeAudit(
        session.supabase,
        { customerId: denied.customer_id, customerUserId: denied.customer_user_id },
        session.clientId,
        { toolName, status: "denied", errorCode: session.access.reason, durationMs: Date.now() - started, fieldNames },
      );
    }
    return failure("access_denied", session.access.message);
  }
  const context = session.access.context;
  const actor: DomainActor = {
    userId: session.userId,
    customerId: context.customer_id,
    customerUserId: context.customer_user_id,
    role: context.role,
  };

  let idempotencyKey: string | null = null;
  let reserved = false;

  const audit = (status: AuditStatus, extra: { errorCode?: string; recordIds?: string[] } = {}) =>
    writeAudit(session.supabase, actor, session.clientId, {
      toolName,
      status,
      errorCode: extra.errorCode ?? null,
      durationMs: Date.now() - started,
      recordIds: extra.recordIds,
      fieldNames,
      idempotencyKey,
    });

  try {
    // 2. Is this tool callable for this company and role, right now?
    const decision = authorizeToolCall(context, toolName);
    if (!decision.ok) throw new McpToolError(decision.code, decision.message);
    const tool = decision.tool;

    // 3. Per-person rate limit, from Postgres.
    if ((await countRecentCalls(session.supabase, actor.customerUserId, session.now())) >= MCP_RATE_LIMIT_MAX_CALLS) {
      throw new McpToolError("rate_limited", "Too many requests. Please wait a minute and try again.");
    }

    // 4. Input. Unknown keys (customer_id, owner_id, role, ...) are
    //    stripped by Zod and never reach the handler.
    const parsed = tool.inputSchema.safeParse(rawArguments ?? {});
    if (!parsed.success) throw new McpToolError("invalid_input", zodIssues(parsed.error));
    const input = parsed.data as Record<string, unknown>;

    // 5. Idempotent creates — only when the client supplied a key. Without
    //    one, every call is a new create (the server never invents a key,
    //    which could merge two genuinely distinct requests).
    if (tool.idempotent && typeof input.idempotency_key === "string") {
      idempotencyKey = input.idempotency_key;
      const reservation = await reserveIdempotencyKey(session.supabase, actor, tool.name, idempotencyKey, session.now());
      if (reservation.kind === "replay") {
        // The stored id is only a claim (the person's own token wrote it);
        // the record must exist and be visible to them right now.
        if (!tool.replayTable) throw new McpToolError("internal_error", "Something went wrong. Please try again.");
        const recordId = await verifyReplayRecord(session.supabase, actor.customerId, tool.replayTable, reservation.recordId);
        await audit("ok", { recordIds: [recordId] });
        return success({ id: recordId, created: false, replayed: true });
      }
      reserved = true;
    }

    // 6. Execute as the caller.
    const result = await withTimeout(
      tool.handler({ supabase: session.supabase, actor, afterResponse: session.afterResponse }, input),
    );

    // 7. Output allowlist — a stripped key is a projection bug, logged.
    const { data, stripped } = enforceOutputAllowlist(result.data, tool.outputFields);
    if (stripped.length > 0) console.error(`[mcp] ${tool.name} response had non-allowlisted keys removed: ${stripped.join(", ")}`);

    if (reserved && idempotencyKey) {
      const createdId = typeof data.id === "string" ? data.id : null;
      await settleIdempotencyKey(session.supabase, actor.customerUserId, idempotencyKey, { status: "succeeded", recordId: createdId });
    }

    await audit("ok", { recordIds: result.recordIds });
    if (context.connection) session.afterResponse(() => touchConnection(session.supabase, context.connection!, session.now()));
    return success(data);
  } catch (error) {
    // After a TIMEOUT the write may still land, so the reservation stays
    // "pending": a retry with the same key gets "still being processed"
    // instead of creating a duplicate. Any other failure frees the key.
    const timedOut = error instanceof McpToolError && error.code === "timeout";
    if (reserved && idempotencyKey && !timedOut) {
      await settleIdempotencyKey(session.supabase, actor.customerUserId, idempotencyKey, { status: "failed" });
    }
    if (error instanceof McpToolError) {
      await audit(auditStatusFor(error.code), { errorCode: error.code });
      return failure(error.code, error.message);
    }
    console.error(`[mcp] ${toolName} failed unexpectedly: ${error instanceof Error ? error.name : "unknown error"}.`);
    await audit("error", { errorCode: "internal_error" });
    return failure("internal_error", "Something went wrong. Please try again.");
  }
}
