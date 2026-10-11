import { after } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCP_MAX_REQUEST_BODY_BYTES } from "@/features/mcp/config/limits";
import { CORS_HEADERS, deniedWithHttp401, methodNotAllowed, unauthorized, withCors } from "@/features/mcp/lib/http";
import { buildMcpServer } from "@/features/mcp/lib/server";
import { createMcpSession } from "@/features/mcp/lib/session";
import { verifyBearerToken } from "@/features/mcp/lib/verify-token";

/**
 * The remote MCP endpoint — one shared, multi-tenant URL for every
 * company. Stateless Streamable HTTP with JSON responses: every POST is
 * authenticated, authorized and executed on its own, with no server-side
 * session to cache anybody's access.
 *
 * Per request: verify the bearer token (verify-token.ts) -> build a
 * Supabase client from THAT token -> read the person's live access
 * (get_my_mcp_context, which also confirms the token's sign-in session
 * still exists) -> handle the one JSON-RPC message. The tenant,
 * the person and their role all come from the token and the database,
 * never from the request body. Thin by design (CLAUDE.md Section I):
 * everything that decides anything lives in features/mcp/lib.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const verified = await verifyBearerToken(authorization);
  if (!verified.ok) return unauthorized(verified.failure !== "missing");

  const session = await createMcpSession(verified.token, (task) => after(task));

  // A token whose sign-in has ended (signed out, timed out, banned) is no
  // longer a valid credential: answer like any invalid token, so the client
  // refreshes — which fails for a deleted session — and re-authenticates.
  if (deniedWithHttp401(session.access)) return unauthorized(true);

  const server = buildMcpServer(session);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
  });

  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(request));
  } finally {
    after(async () => {
      await transport.close();
      await server.close();
    });
  }
}

/** No server-initiated stream in stateless mode. A missing/invalid token
 *  still gets the discovery 401 first, so probing clients learn where to
 *  sign in. */
export async function GET(request: Request): Promise<Response> {
  const verified = await verifyBearerToken(request.headers.get("authorization"));
  if (!verified.ok) return unauthorized(verified.failure !== "missing");
  return methodNotAllowed();
}

export async function DELETE(request: Request): Promise<Response> {
  const verified = await verifyBearerToken(request.headers.get("authorization"));
  if (!verified.ok) return unauthorized(verified.failure !== "missing");
  return methodNotAllowed();
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
