import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DomainActor } from "@/types/customer";
import {
  MCP_IDEMPOTENCY_STALE_PENDING_MINUTES,
  MCP_LAST_USED_TOUCH_INTERVAL_SECONDS,
  MCP_RATE_LIMIT_WINDOW_SECONDS,
} from "../config/limits";
import { IDENTITY_ARGUMENT_NAMES } from "../registry/fields";
import type { McpReplayTable } from "../registry/types";
import { McpToolError, invalidInput, notFound } from "./errors";

/**
 * Audit, rate-limit, idempotency and last-used writes — all through the
 * CALLER'S OWN client, so mcp_audit_log/mcp_idempotency_keys/
 * mcp_connections RLS (20261010120000_mcp_platform.sql) applies to every
 * one of them. No values from tool arguments are ever written here: the
 * audit row carries field NAMES and record ids only.
 */

export type AuditStatus = "ok" | "denied" | "invalid" | "error" | "rate_limited";

export type AuditEntry = {
  toolName: string;
  status: AuditStatus;
  errorCode?: string | null;
  durationMs: number;
  recordIds?: string[];
  fieldNames?: string[];
  idempotencyKey?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z_]{0,62}$/;

/**
 * Argument NAMES only — never values — and only names on an allowlist:
 * the tool's own parameters plus IDENTITY_ARGUMENT_NAMES. A client can
 * therefore never smuggle free text into the audit log by inventing
 * parameter names.
 */
export function auditFieldNames(rawArguments: unknown, allowed: readonly string[]): string[] {
  if (!rawArguments || typeof rawArguments !== "object" || Array.isArray(rawArguments)) return [];
  const permitted = new Set([...allowed, ...IDENTITY_ARGUMENT_NAMES]);
  return Object.keys(rawArguments)
    .filter((key) => permitted.has(key) && NAME.test(key))
    .slice(0, 50);
}

/** The audit log stores this, never the key itself (a client may put
 *  anything in a key, including personal data). */
export function hashIdempotencyKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export async function writeAudit(
  supabase: SupabaseClient,
  actor: Pick<DomainActor, "customerId" | "customerUserId">,
  clientId: string,
  entry: AuditEntry,
): Promise<void> {
  const { error } = await supabase.from("mcp_audit_log").insert({
    customer_id: actor.customerId,
    customer_user_id: actor.customerUserId,
    oauth_client_id: clientId.slice(0, 255),
    tool_name: NAME.test(entry.toolName) ? entry.toolName : "unknown_tool",
    status: entry.status,
    error_code: entry.errorCode && /^[a-z_]{1,64}$/.test(entry.errorCode) ? entry.errorCode : null,
    duration_ms: Math.max(0, Math.round(entry.durationMs)),
    record_ids: (entry.recordIds ?? []).filter((id) => UUID.test(id)).slice(0, 100),
    field_names: (entry.fieldNames ?? []).filter((name) => NAME.test(name)).slice(0, 50),
    idempotency_key_sha256: entry.idempotencyKey ? hashIdempotencyKey(entry.idempotencyKey) : null,
  });
  if (error) {
    // Operational signal only: no ids, no arguments, no database text.
    console.error(`[mcp] audit write failed for ${entry.toolName} (code ${error.code ?? "unknown"}).`);
  }
}

/** Tool calls this person made in the current rolling window. */
export async function countRecentCalls(supabase: SupabaseClient, customerUserId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - MCP_RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString();
  const { count, error } = await supabase
    .from("mcp_audit_log")
    .select("id", { count: "exact", head: true })
    .eq("customer_user_id", customerUserId)
    .gte("created_at", since);
  if (error) {
    // Fail closed: if the limit cannot be read, the call is not allowed.
    throw new McpToolError("internal_error", "Could not check the request rate. Please try again.");
  }
  return count ?? 0;
}

export type Reservation = { kind: "proceed" } | { kind: "replay"; recordId: string | null };

/**
 * Atomically claims an idempotency key. The unique index on
 * (customer_id, idempotency_key) means two concurrent calls with the same
 * key cannot both get "proceed".
 */
export async function reserveIdempotencyKey(
  supabase: SupabaseClient,
  actor: Pick<DomainActor, "customerId" | "customerUserId">,
  toolName: string,
  key: string,
  now: Date = new Date(),
): Promise<Reservation> {
  const { error } = await supabase.from("mcp_idempotency_keys").insert({
    customer_id: actor.customerId,
    customer_user_id: actor.customerUserId,
    idempotency_key: key,
    tool_name: toolName,
  });
  if (!error) return { kind: "proceed" };
  if (error.code !== "23505") {
    throw new McpToolError("internal_error", "Could not record this request. Please try again.");
  }

  const { data: existing } = await supabase
    .from("mcp_idempotency_keys")
    .select("tool_name, status, record_id, updated_at")
    .eq("customer_user_id", actor.customerUserId)
    .eq("idempotency_key", key)
    .maybeSingle();

  // Someone else in the company holds this key — RLS hides their row.
  if (!existing) throw invalidInput("This idempotency_key has already been used. Send a new one.");
  if (existing.tool_name !== toolName) throw invalidInput("This idempotency_key was already used for a different action.");
  if (existing.status === "succeeded") return { kind: "replay", recordId: (existing.record_id as string | null) ?? null };
  if (existing.status === "pending") {
    // Abandoned (the server stopped mid-request)? Never retried here: the
    // create may have completed, and retrying could duplicate it.
    const age = now.getTime() - new Date(String(existing.updated_at)).getTime();
    if (Number.isFinite(age) && age > MCP_IDEMPOTENCY_STALE_PENDING_MINUTES * 60_000) {
      throw new McpToolError(
        "conflict",
        "An earlier request with this idempotency_key never finished, so it is unknown whether the record was created. " +
          "Search for it first; if it is not there, try again with a new idempotency_key.",
      );
    }
    throw new McpToolError("conflict", "A request with this idempotency_key is still being processed.");
  }

  // A previous attempt failed: claim it back only if nobody else did.
  const { data: reclaimed } = await supabase
    .from("mcp_idempotency_keys")
    .update({ status: "pending", record_id: null })
    .eq("customer_user_id", actor.customerUserId)
    .eq("idempotency_key", key)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();
  if (!reclaimed) throw new McpToolError("conflict", "A request with this idempotency_key is still being processed.");
  return { kind: "proceed" };
}

export async function settleIdempotencyKey(
  supabase: SupabaseClient,
  customerUserId: string,
  key: string,
  outcome: { status: "succeeded"; recordId: string | null } | { status: "failed" },
): Promise<void> {
  const { error } = await supabase
    .from("mcp_idempotency_keys")
    .update(outcome.status === "succeeded" ? { status: "succeeded", record_id: outcome.recordId } : { status: "failed" })
    .eq("customer_user_id", customerUserId)
    .eq("idempotency_key", key);
  if (error) console.error(`[mcp] could not settle an idempotency key (code ${error.code ?? "unknown"}).`);
}

/**
 * Before answering a replay, re-reads the recorded id through the normal
 * RLS-protected path. A reservation row is written with the person's own
 * token, so its record_id is only a claim; the record itself must exist in
 * the caller's company and be visible to them now, or the replay is
 * answered with the generic not_found.
 */
export async function verifyReplayRecord(
  supabase: SupabaseClient,
  customerId: string,
  table: McpReplayTable,
  recordId: string | null,
): Promise<string> {
  if (!recordId || !UUID.test(recordId)) throw notFound();
  const { data, error } = await supabase
    .from(table)
    .select("id")
    .eq("id", recordId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error || !data) throw notFound();
  return recordId;
}

/** Refreshes last_used_at at most every MCP_LAST_USED_TOUCH_INTERVAL_SECONDS. */
export async function touchConnection(
  supabase: SupabaseClient,
  connection: { id: string; last_used_at: string | null },
  now: Date,
): Promise<void> {
  const last = connection.last_used_at ? new Date(connection.last_used_at).getTime() : 0;
  if (now.getTime() - last < MCP_LAST_USED_TOUCH_INTERVAL_SECONDS * 1000) return;
  const { error } = await supabase.from("mcp_connections").update({ last_used_at: now.toISOString() }).eq("id", connection.id);
  if (error) console.error(`[mcp] could not record connection use (code ${error.code ?? "unknown"}).`);
}
