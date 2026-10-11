import { getProtectedResourceMetadataUrl } from "./urls";

/**
 * HTTP-level helpers for /api/mcp and its discovery document.
 *
 * CORS is open (`*`) on purpose and is safe here: the endpoint
 * authenticates ONLY with a bearer token in the Authorization header,
 * never with cookies, so a cross-origin page gains nothing it could not
 * already do with the token itself. It lets browser-based MCP clients
 * (e.g. the MCP Inspector) reach the server.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The 401 that starts OAuth discovery (RFC 9728 + MCP authorization).
 * Claude requires a 401 — it ignores WWW-Authenticate on any other status.
 * `invalid_token` is added only when a token WAS sent; the reason is never
 * detailed beyond that, per CLAUDE.md Section K.
 */
export function unauthorized(tokenWasSent: boolean): Response {
  const parts = [`Bearer resource_metadata="${getProtectedResourceMetadataUrl()}"`, `scope="openid"`];
  if (tokenWasSent) parts.push(`error="invalid_token"`, `error_description="The access token is missing, expired or invalid."`);

  return withCors(
    new Response(JSON.stringify({ error: "unauthorized", message: "Sign in to continue." }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": parts.join(", ") },
    }),
  );
}

/**
 * Which access denials are answered at the HTTP level with 401 rather
 * than as an MCP tool error. Only an ENDED sign-in session: the token is
 * no longer a valid credential, so the client should refresh (which fails
 * for a deleted session) and re-authenticate. Everything else (blocked,
 * company off, disconnected, unverifiable session) is reported inside MCP
 * so the person sees why — and a 401 there would only cause a re-auth loop.
 */
export function deniedWithHttp401(access: { ok: boolean; reason?: string }): boolean {
  return !access.ok && access.reason === "session_ended";
}

export function methodNotAllowed(): Response {
  return withCors(
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST, OPTIONS" },
    }),
  );
}
