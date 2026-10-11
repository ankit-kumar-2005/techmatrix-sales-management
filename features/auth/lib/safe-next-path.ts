/**
 * Where login may send someone afterwards, instead of the default
 * Pipeline page. Deliberately an ALLOWLIST of in-app paths, not "any
 * relative URL": an open ?next= is a classic phishing redirect. Today the
 * only legitimate return target is the OAuth consent screen, which signed-
 * out people reach from an AI app's "connect" flow.
 */
const ALLOWED_PREFIXES = ["/oauth/consent"];

export function safeNextPath(raw: string | undefined | null): string | null {
  if (!raw || raw.length > 512) return null;
  // Same-origin path only: no scheme, no protocol-relative //host, no
  // backslash tricks browsers normalise into //host.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw, "https://same-origin.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://same-origin.invalid") return null;

  const allowed = ALLOWED_PREFIXES.some((prefix) => parsed.pathname === prefix);
  return allowed ? `${parsed.pathname}${parsed.search}` : null;
}
