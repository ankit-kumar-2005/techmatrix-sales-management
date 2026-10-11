import { BRAND_NAME } from "@/lib/brand";
import { createBearerClient } from "@/lib/supabase/bearer";
import type { McpToolContext } from "../registry/types";
import { evaluateAccess, parseMcpContext, type AccessDecision } from "./access";
import type { McpSession } from "./handle-call";
import type { VerifiedToken } from "./verify-token";

/**
 * Builds one request's session: a Supabase client acting as the token's
 * owner, and that person's live access state from get_my_mcp_context().
 * The client id passed to the RPC comes from the VERIFIED token, never
 * from the request body.
 */
export async function createMcpSession(
  token: VerifiedToken,
  afterResponse: McpToolContext["afterResponse"],
): Promise<McpSession> {
  const supabase = createBearerClient(token.accessToken);
  const { data, error } = await supabase.rpc("get_my_mcp_context", { p_oauth_client_id: token.clientId });

  const access: AccessDecision = error
    ? {
        ok: false,
        reason: "unavailable",
        message: `${BRAND_NAME} could not check your access right now. Please try again in a moment.`,
      }
    : evaluateAccess(parseMcpContext(data));

  return { userId: token.userId, clientId: token.clientId, supabase, access, afterResponse, now: () => new Date() };
}
