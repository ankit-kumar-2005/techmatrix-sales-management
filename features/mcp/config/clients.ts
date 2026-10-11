/**
 * WHICH OAUTH REDIRECT TARGETS THE CONSENT SCREEN WILL APPROVE IN v1.
 *
 * Dynamic Client Registration is open: anyone can register an OAuth
 * client with any name and any redirect URI, and the name is whatever
 * the client claims. The consent screen is therefore the gate — it shows
 * the real redirect host and refuses anything not listed here, so a
 * look-alike "Claude" app sending codes to some other domain cannot be
 * approved through Pipeway.
 *
 * Verified 2026-10-10 against Anthropic's connector authentication docs
 * (claude.com/docs/connectors/building/authentication):
 *   - hosted Claude apps (web, desktop, mobile, Cowork) use exactly
 *     https://claude.ai/api/mcp/auth_callback, and Anthropic asks servers
 *     that allowlist to also allow https://claude.com/api/mcp/auth_callback;
 *   - Claude Code uses an RFC 8252 loopback redirect on an ephemeral port:
 *     http://localhost:<port>/callback or http://127.0.0.1:<port>/callback.
 *
 * To allow another client (e.g. the MCP Inspector for local testing),
 * add its exact HTTPS or loopback callback to
 * MCP_ADDITIONAL_REDIRECT_URIS (comma-separated, exact match) — an
 * operator decision, documented in docs/mcp.md.
 */

export const MCP_ALLOWED_REDIRECT_URIS: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/** Loopback hosts accepted on ANY port, but only on this exact path. */
export const MCP_LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];
export const MCP_LOOPBACK_PATH = "/callback";

export function getAdditionalRedirectUris(): string[] {
  return (process.env.MCP_ADDITIONAL_REDIRECT_URIS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
