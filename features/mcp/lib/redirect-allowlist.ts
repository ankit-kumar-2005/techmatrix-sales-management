import {
  MCP_ALLOWED_REDIRECT_URIS,
  MCP_LOOPBACK_HOSTS,
  MCP_LOOPBACK_PATH,
  getAdditionalRedirectUris,
} from "../config/clients";

export type RedirectCheck =
  | { allowed: true; host: string; isLoopback: boolean }
  | { allowed: false; host: string | null };

/** scheme://host[:port]/path — query and fragment never take part in a match. */
function normalize(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * Is this OAuth redirect URI one the consent screen may approve? Pure, so
 * the rule is unit-tested directly (redirect-allowlist.test.ts).
 *
 *   exact match   against MCP_ALLOWED_REDIRECT_URIS and the operator's
 *                 MCP_ADDITIONAL_REDIRECT_URIS (scheme, host, port, path);
 *   loopback      http on localhost/127.0.0.1, any port, path exactly
 *                 MCP_LOOPBACK_PATH — Claude Code's RFC 8252 redirect.
 *
 * Anything with credentials in the URL, a non-http(s) scheme, or that
 * fails to parse is refused.
 */
export function checkRedirectUri(raw: string, additional: string[] = getAdditionalRedirectUris()): RedirectCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, host: null };
  }

  if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return { allowed: false, host: url.hostname || null };
  }

  const candidate = normalize(url);
  const exact = [...MCP_ALLOWED_REDIRECT_URIS, ...additional].some((allowed) => {
    try {
      return normalize(new URL(allowed)) === candidate;
    } catch {
      return false;
    }
  });
  if (exact) {
    return { allowed: true, host: url.hostname, isLoopback: MCP_LOOPBACK_HOSTS.includes(url.hostname) };
  }

  if (url.protocol === "http:" && MCP_LOOPBACK_HOSTS.includes(url.hostname) && url.pathname === MCP_LOOPBACK_PATH) {
    return { allowed: true, host: url.hostname, isLoopback: true };
  }

  return { allowed: false, host: url.hostname };
}
