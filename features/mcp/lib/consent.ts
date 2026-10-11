import type { SupabaseClient } from "@supabase/supabase-js";
import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { BRAND_NAME } from "@/lib/brand";
import { MCP_TOOL_GROUPS } from "../registry/index";
import type { McpToolGroup } from "../registry/types";
import { listVisibleTools, parseMcpContext, type McpContext } from "./access";
import { checkRedirectUri } from "./redirect-allowlist";

/**
 * EVERYTHING THE CONSENT SCREEN DECIDES, IN ONE PLACE.
 *
 * Called twice per approval, on purpose: once to render the page, and
 * again inside the Allow action right before the grant — so nothing shown
 * on the page (or submitted from it) is trusted. Only the authorization
 * id comes from the browser; the client, its redirect URI and the
 * person's access are all re-read server-side as the signed-in user.
 *
 * Never auto-approves. Supabase itself skips consent for a client the
 * person already approved (it returns only a redirect_url); even then the
 * redirect is checked against the allowlist and the person's access
 * before the browser is sent anywhere.
 */

export const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type CapabilitySummary = { group: McpToolGroup; read: boolean; create: boolean; update: boolean };

export type ConsentState =
  | { kind: "invalid" }
  | { kind: "refused"; title: string; message: string }
  | { kind: "already_approved"; redirectUrl: string }
  | {
      kind: "ask";
      authorizationId: string;
      clientId: string;
      clientName: string;
      redirectHost: string;
      isLoopback: boolean;
      userName: string;
      companyName: string;
      capabilities: CapabilitySummary[];
      canChange: boolean;
    };

export function summarizeCapabilities(context: McpContext): CapabilitySummary[] {
  const visible = listVisibleTools(context);
  return MCP_TOOL_GROUPS.map((group) => {
    const tools = visible.filter((tool) => tool.group === group);
    return {
      group,
      read: tools.some((tool) => tool.capability === "read"),
      create: tools.some((tool) => tool.capability === "create"),
      update: tools.some((tool) => tool.capability === "update"),
    };
  }).filter((summary) => summary.read || summary.create || summary.update);
}

function refused(title: string, message: string): ConsentState {
  return { kind: "refused", title, message };
}

/** The client name is self-asserted at registration, so it is shown
 *  bounded and never trusted for anything. */
function displayName(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().slice(0, 80);
  return trimmed.length > 0 ? trimmed : "An AI app";
}

export async function loadConsentState(supabase: SupabaseClient, authorizationId: string): Promise<ConsentState> {
  if (!AUTHORIZATION_ID_PATTERN.test(authorizationId)) return { kind: "invalid" };

  const { data: details, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !details) return { kind: "invalid" };

  const { data: rawContext, error: contextError } = await supabase.rpc("get_my_mcp_context", {
    p_oauth_client_id: "client" in details ? details.client.id : null,
  });
  if (contextError) {
    return refused("Something went wrong", `${BRAND_NAME} could not check your access. Please try again.`);
  }
  const context = parseMcpContext(rawContext);

  if (!context) {
    return refused(
      "Your account isn't active",
      `Your ${BRAND_NAME} account isn't an active member of a company, so it can't be connected to an AI app.`,
    );
  }
  if (context.person_blocked) {
    return refused(
      "AI connections are blocked",
      `A ${BRAND_NAME} administrator has blocked AI connections for your account. Contact your administrator if you think this is a mistake.`,
    );
  }
  if (!context.mcp_enabled) {
    return refused(
      "AI connections are turned off",
      `${context.company_name ?? "Your company"} hasn't turned on AI connections yet. Ask a ${BRAND_NAME} administrator to switch them on in Settings → AI Connections, then try again.`,
    );
  }

  // Already approved earlier: Supabase has issued a code without asking.
  if (!("client" in details)) {
    const check = checkRedirectUri(details.redirect_url);
    if (!check.allowed) return refused("This app isn't supported", unsupportedClientMessage(check.host));
    return { kind: "already_approved", redirectUrl: details.redirect_url };
  }

  const approval = details as OAuthAuthorizationDetails;
  const check = checkRedirectUri(approval.redirect_uri);
  if (!check.allowed) return refused("This app isn't supported", unsupportedClientMessage(check.host));

  // A disconnect is final for that OAuth client (the database refuses to
  // clear revoked_at). Reconnecting means the AI app registering afresh.
  if (context.connection?.revoked) {
    return refused(
      "Reconnect by adding the app again",
      `You disconnected ${displayName(approval.client.name)} from ${BRAND_NAME} earlier, so this connection can't be reused. ` +
        `Remove ${BRAND_NAME} from the app's connector list, add it again, and then approve the new request.`,
    );
  }

  return {
    kind: "ask",
    authorizationId,
    clientId: approval.client.id,
    clientName: displayName(approval.client.name),
    redirectHost: check.host,
    isLoopback: check.isLoopback,
    userName: context.user_name ?? approval.user.email,
    companyName: context.company_name ?? "your company",
    capabilities: summarizeCapabilities(context),
    canChange: context.allow_writes && listVisibleTools(context).some((tool) => tool.kind === "write"),
  };
}

function unsupportedClientMessage(host: string | null): string {
  return (
    `${BRAND_NAME} can currently be connected to Claude (web, desktop and Claude Code). ` +
    `This request would send you to ${host ?? "an unknown address"}, which isn't on the approved list, so it can't be approved here.`
  );
}

/**
 * Records the connection as the signed-in person, under RLS, BEFORE the
 * grant is approved. Returns false when the person may not connect: the
 * INSERT policy refuses a blocked person, and a connection they already
 * disconnected for this OAuth client can never be revived (one-way
 * revoked_at) — they reconnect by having the AI app register a new client.
 * created_at/last_used_at are stamped/required-null by the database.
 */
export async function registerConnection(
  supabase: SupabaseClient,
  context: McpContext,
  connection: { clientId: string; clientName: string; redirectHost: string },
): Promise<boolean> {
  if (context.connection?.revoked) return false;

  const { error } = await supabase.from("mcp_connections").upsert(
    {
      customer_id: context.customer_id,
      customer_user_id: context.customer_user_id,
      oauth_client_id: connection.clientId,
      client_name: connection.clientName,
      redirect_domain: connection.redirectHost,
    },
    { onConflict: "customer_user_id,oauth_client_id", ignoreDuplicates: true },
  );
  return !error;
}
