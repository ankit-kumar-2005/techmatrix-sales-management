"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership, getNoMembershipRedirect } from "@/features/customers/lib/get-current-membership";
import { isRegisteredToolName } from "./registry/index";

/**
 * Settings → AI Connections (admin) and Settings → My AI Connections
 * (everyone). The admin actions are ADMIN-role-gated here as the UX layer;
 * the admin-only RLS on customer_mcp_settings/customer_mcp_tools and the
 * protect_mcp_connection_columns trigger are the real boundary and hold
 * even if these checks were bypassed. customer_id is always the caller's
 * own — never read from input.
 */

export type McpActionResult = { ok: true } | { ok: false; error: string };

const NOT_ALLOWED: McpActionResult = { ok: false, error: "You don't have permission to do this." };
const FAILED: McpActionResult = { ok: false, error: "Something went wrong. Please try again." };

async function requireMembership() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) redirect(await getNoMembershipRedirect(supabase, user.id));
  return { supabase, user, membership };
}

async function requireAdmin() {
  const context = await requireMembership();
  return context.membership.role === "ADMIN" ? context : null;
}

function done(): McpActionResult {
  revalidatePath("/settings/ai-connections");
  return { ok: true };
}

export async function setAiConnectionsEnabledAction(enabled: boolean): Promise<McpActionResult> {
  if (typeof enabled !== "boolean") return FAILED;
  const admin = await requireAdmin();
  if (!admin) return NOT_ALLOWED;

  const { error } = await admin.supabase
    .from("customer_mcp_settings")
    .upsert({ customer_id: admin.membership.customer.id, enabled, updated_by: admin.user.id }, { onConflict: "customer_id" });
  return error ? FAILED : done();
}

export async function setAllowChangesAction(allowWrites: boolean): Promise<McpActionResult> {
  if (typeof allowWrites !== "boolean") return FAILED;
  const admin = await requireAdmin();
  if (!admin) return NOT_ALLOWED;

  const { error } = await admin.supabase
    .from("customer_mcp_settings")
    .upsert(
      { customer_id: admin.membership.customer.id, allow_writes: allowWrites, updated_by: admin.user.id },
      { onConflict: "customer_id" },
    );
  return error ? FAILED : done();
}

export async function setToolEnabledAction(toolName: string, enabled: boolean): Promise<McpActionResult> {
  // Unknown names are rejected against the code registry, never stored.
  if (typeof toolName !== "string" || !isRegisteredToolName(toolName) || typeof enabled !== "boolean") return FAILED;
  const admin = await requireAdmin();
  if (!admin) return NOT_ALLOWED;

  const { error } = await admin.supabase
    .from("customer_mcp_tools")
    .upsert(
      { customer_id: admin.membership.customer.id, tool_name: toolName, enabled, updated_by: admin.user.id },
      { onConflict: "customer_id,tool_name" },
    );
  return error ? FAILED : done();
}

const uuid = z.string().uuid();

/**
 * Blocks (or unblocks) one PERSON in the admin's company from using AI
 * connections — whether or not they have connected yet. Per person, not
 * per connection: Claude registers a new client on every reconnect, so a
 * per-connection block could be sidestepped. Takes effect on that
 * person's very next MCP request and stops them registering new
 * connections. The admin-only RLS on mcp_user_blocks and its composite
 * foreign key (the person must belong to the admin's own company) are the
 * boundary; blocked_by/created_at are stamped by the database.
 */
export async function setPersonBlockedAction(customerUserId: string, blocked: boolean): Promise<McpActionResult> {
  if (!uuid.safeParse(customerUserId).success || typeof blocked !== "boolean") return FAILED;
  const admin = await requireAdmin();
  if (!admin) return NOT_ALLOWED;
  if (blocked && customerUserId === admin.membership.membership.id) {
    return { ok: false, error: "You can't block your own AI connections. Turn AI Connections off instead." };
  }

  const { error } = blocked
    ? await admin.supabase
        .from("mcp_user_blocks")
        .upsert(
          { customer_id: admin.membership.customer.id, customer_user_id: customerUserId },
          { onConflict: "customer_id,customer_user_id", ignoreDuplicates: true },
        )
    : await admin.supabase
        .from("mcp_user_blocks")
        .delete()
        .eq("customer_id", admin.membership.customer.id)
        .eq("customer_user_id", customerUserId);
  return error ? FAILED : done();
}

/**
 * The person disconnects one of their own AI apps: marks their own
 * connection disconnected (MCP refuses it on the next request, before the
 * access token even expires) and revokes the OAuth grant in Supabase Auth
 * so the app can no longer refresh. Final for that OAuth client: to use
 * the app again, they remove and re-add the connector, which registers a
 * new client and goes through consent again.
 */
export async function disconnectMyConnectionAction(clientId: string): Promise<McpActionResult> {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 255) return FAILED;
  const { supabase, membership } = await requireMembership();

  // Only a still-active row: revoked_at is one-way, and the database
  // refuses to move an existing disconnect timestamp.
  const { error: markError } = await supabase
    .from("mcp_connections")
    .update({ revoked_at: new Date().toISOString() })
    .eq("customer_user_id", membership.membership.id)
    .eq("oauth_client_id", clientId)
    .is("revoked_at", null);
  if (markError) return FAILED;

  const { error: revokeError } = await supabase.auth.oauth.revokeGrant({ clientId });
  if (revokeError) {
    console.error(`[mcp] grant revocation failed (status ${revokeError.status ?? "unknown"}).`);
    revalidatePath("/settings/my-ai-connections");
    return { ok: false, error: "The app was disconnected here, but its sign-in could not be revoked. Please try again." };
  }

  revalidatePath("/settings/my-ai-connections");
  return { ok: true };
}
