import { BRAND_NAME } from "@/lib/brand";
import { resolveAppUrl } from "@/lib/app-url";
import { CORS_HEADERS, withCors } from "@/features/mcp/lib/http";
import { getAuthorizationServerIssuer, getMcpResourceUrl } from "@/features/mcp/lib/urls";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for /api/mcp.
 *
 * Served at both /.well-known/oauth-protected-resource/api/mcp (what the
 * 401's resource_metadata points to, and what clients probe first) and
 * the bare /.well-known/oauth-protected-resource (their fallback). It
 * names the Supabase Auth OAuth 2.1 server as the ONLY authorization
 * server — Claude uses the first entry and never falls back.
 *
 * Public by design: it contains no secrets, only where to sign in.
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ resource?: string[] }> }): Promise<Response> {
  const { resource = [] } = await params;
  const path = resource.join("/");
  if (path !== "" && path !== "api/mcp") {
    return withCors(new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } }));
  }

  const body = {
    resource: getMcpResourceUrl(),
    authorization_servers: [getAuthorizationServerIssuer()],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid"],
    resource_name: BRAND_NAME,
    resource_documentation: `${resolveAppUrl().url}/settings/ai-connections`,
  };
  return withCors(
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
