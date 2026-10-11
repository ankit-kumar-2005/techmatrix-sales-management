import { resolveAppUrl } from "@/lib/app-url";

/**
 * The MCP server's public URLs, all derived from the app's own origin
 * (APP_URL in production — see lib/app-url.ts). The resource URL must
 * equal, exactly, the URL people paste into Claude.
 */
export function getMcpResourceUrl(): string {
  return `${resolveAppUrl().url}/api/mcp`;
}

export function getProtectedResourceMetadataUrl(): string {
  return `${resolveAppUrl().url}/.well-known/oauth-protected-resource/api/mcp`;
}

export function getAuthorizationServerIssuer(): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/auth/v1`;
}
