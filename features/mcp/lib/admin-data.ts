import type { SupabaseClient } from "@supabase/supabase-js";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { MCP_ADMIN_ACTIVITY_ROWS } from "../config/limits";
import { MCP_TOOLS, defaultToolEnabled } from "../registry/index";
import type { McpToolCapability, McpToolGroup, McpToolKind } from "../registry/types";

/**
 * Data for Settings → AI Connections and Settings → My AI Connections.
 * Every read runs on the caller's cookie client, so the admin-only RLS on
 * customer_mcp_settings/customer_mcp_tools/mcp_user_blocks and the
 * admin-or-self RLS on mcp_connections/mcp_audit_log decide what comes
 * back — these functions only shape it.
 */

export type CatalogTool = {
  name: string;
  label: string;
  summary: string;
  group: McpToolGroup;
  kind: McpToolKind;
  capability: McpToolCapability;
  enabled: boolean;
};

export type ConnectionRow = {
  id: string;
  customerUserId: string;
  personName: string;
  personEmail: string | null;
  clientId: string;
  clientName: string;
  redirectDomain: string;
  createdAt: string;
  lastUsedAt: string | null;
  status: "active" | "disconnected" | "blocked";
};

/** Every active member, for blocking — including people who have never
 *  connected (a block can be placed before the first connection). */
export type TeamMemberRow = {
  customerUserId: string;
  name: string;
  email: string | null;
  blocked: boolean;
  blockedAt: string | null;
  isSelf: boolean;
};

export type ActivityRow = {
  id: string;
  personName: string;
  toolLabel: string;
  status: "ok" | "denied" | "invalid" | "error" | "rate_limited";
  errorCode: string | null;
  createdAt: string;
};

export type AiConnectionsAdminData = {
  enabled: boolean;
  allowWrites: boolean;
  catalog: CatalogTool[];
  connections: ConnectionRow[];
  team: TeamMemberRow[];
  activity: ActivityRow[];
  activePeople: number;
};

const TOOL_LABEL = new Map(MCP_TOOLS.map((tool) => [tool.name, tool.label]));

type RawConnection = {
  id: string;
  customer_user_id: string;
  oauth_client_id: string;
  client_name: string;
  redirect_domain: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

const CONNECTION_COLUMNS = "id, customer_user_id, oauth_client_id, client_name, redirect_domain, created_at, last_used_at, revoked_at";

function connectionStatus(row: RawConnection, personBlocked: boolean): ConnectionRow["status"] {
  if (row.revoked_at) return "disconnected";
  return personBlocked ? "blocked" : "active";
}

export async function getAiConnectionsAdminData(
  supabase: SupabaseClient,
  customerId: string,
  currentCustomerUserId: string,
): Promise<AiConnectionsAdminData> {
  const [settingsResult, toolsResult, connectionsResult, blocksResult, activityResult, directory] = await Promise.all([
    supabase.from("customer_mcp_settings").select("enabled, allow_writes").eq("customer_id", customerId).maybeSingle(),
    supabase.from("customer_mcp_tools").select("tool_name, enabled").eq("customer_id", customerId),
    supabase
      .from("mcp_connections")
      .select(CONNECTION_COLUMNS)
      .eq("customer_id", customerId)
      .order("last_used_at", { ascending: false, nullsFirst: false })
      .limit(200),
    supabase.from("mcp_user_blocks").select("customer_user_id, created_at").eq("customer_id", customerId),
    supabase
      .from("mcp_audit_log")
      .select("id, customer_user_id, tool_name, status, error_code, created_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(MCP_ADMIN_ACTIVITY_ROWS),
    getVisibleTeamDirectory(supabase),
  ]);

  const overrides = new Map(
    ((toolsResult.data ?? []) as Array<{ tool_name: string; enabled: boolean }>).map((row) => [row.tool_name, row.enabled]),
  );
  const blocks = new Map(
    ((blocksResult.data ?? []) as Array<{ customer_user_id: string; created_at: string }>).map((row) => [
      row.customer_user_id,
      row.created_at,
    ]),
  );
  const people = new Map(directory.map((person) => [person.customer_user_id, person]));
  // Audit rows outlive memberships, so a name may no longer resolve.
  const nameOf = (customerUserId: string) => {
    const person = people.get(customerUserId);
    return person?.name ?? person?.email ?? "Former team member";
  };

  const rawConnections = (connectionsResult.data ?? []) as RawConnection[];
  const connections: ConnectionRow[] = rawConnections.map((row) => ({
    id: row.id,
    customerUserId: row.customer_user_id,
    personName: nameOf(row.customer_user_id),
    personEmail: people.get(row.customer_user_id)?.email ?? null,
    clientId: row.oauth_client_id,
    clientName: row.client_name,
    redirectDomain: row.redirect_domain,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    status: connectionStatus(row, blocks.has(row.customer_user_id)),
  }));

  const team: TeamMemberRow[] = directory
    .map((person) => ({
      customerUserId: person.customer_user_id,
      name: person.name ?? person.email,
      email: person.email,
      blocked: blocks.has(person.customer_user_id),
      blockedAt: blocks.get(person.customer_user_id) ?? null,
      isSelf: person.customer_user_id === currentCustomerUserId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const activity: ActivityRow[] = (
    (activityResult.data ?? []) as Array<{
      id: string;
      customer_user_id: string;
      tool_name: string;
      status: ActivityRow["status"];
      error_code: string | null;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    personName: nameOf(row.customer_user_id),
    toolLabel: TOOL_LABEL.get(row.tool_name) ?? row.tool_name,
    status: row.status,
    errorCode: row.error_code,
    createdAt: row.created_at,
  }));

  return {
    enabled: settingsResult.data?.enabled === true,
    allowWrites: settingsResult.data?.allow_writes === true,
    catalog: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      label: tool.label,
      summary: tool.summary,
      group: tool.group,
      kind: tool.kind,
      capability: tool.capability,
      enabled: overrides.get(tool.name) ?? defaultToolEnabled(tool),
    })),
    connections,
    team,
    activity,
    activePeople: new Set(connections.filter((c) => c.status === "active" && c.lastUsedAt).map((c) => c.customerUserId)).size,
  };
}

export type MyConnectionRow = {
  clientId: string;
  clientName: string;
  redirectDomain: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
  status: "active" | "disconnected" | "blocked";
};

/**
 * The signed-in person's own connections: their OAuth grants from Supabase
 * Auth (listGrants — only ever their own) merged with their own
 * mcp_connections rows. Whether THEY are blocked comes from their own
 * context (the blocks table itself is admin-only).
 */
export async function getMyAiConnections(supabase: SupabaseClient, customerUserId: string): Promise<MyConnectionRow[]> {
  const [grantsResult, rowsResult, contextResult] = await Promise.all([
    supabase.auth.oauth.listGrants(),
    supabase
      .from("mcp_connections")
      .select(CONNECTION_COLUMNS)
      .eq("customer_user_id", customerUserId)
      .order("created_at", { ascending: false }),
    supabase.rpc("get_my_mcp_context", { p_oauth_client_id: null }),
  ]);

  const personBlocked = (contextResult.data as { person_blocked?: unknown } | null)?.person_blocked === true;
  const rows = (rowsResult.data ?? []) as RawConnection[];
  const grants = grantsResult.data ?? [];
  const byClient = new Map<string, MyConnectionRow>();

  for (const row of rows) {
    byClient.set(row.oauth_client_id, {
      clientId: row.oauth_client_id,
      clientName: row.client_name,
      redirectDomain: row.redirect_domain,
      connectedAt: row.created_at,
      lastUsedAt: row.last_used_at,
      status: connectionStatus(row, personBlocked),
    });
  }
  // A grant with no row here (approved outside the consent screen) is
  // still the person's to see and revoke; MCP refuses it regardless.
  for (const grant of grants) {
    if (!byClient.has(grant.client.id)) {
      byClient.set(grant.client.id, {
        clientId: grant.client.id,
        clientName: grant.client.name || "Unknown app",
        redirectDomain: null,
        connectedAt: grant.granted_at,
        lastUsedAt: null,
        status: personBlocked ? "blocked" : "active",
      });
    }
  }

  return [...byClient.values()];
}
