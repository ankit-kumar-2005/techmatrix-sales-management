/**
 * Where this deployment lives, as an absolute origin.
 *
 * SERVER-ONLY, and deliberately NOT a NEXT_PUBLIC_* variable: the
 * browser already knows its own origin (window.location.origin — what
 * every browser-initiated auth call in this app uses). This exists for
 * the one case that has no window: a Server Action asking Supabase Auth
 * to email somebody a link, where emailRedirectTo must be absolute.
 *
 *   APP_URL      — set this in production (e.g. https://app.example.com)
 *   VERCEL_URL   — provided automatically by Vercel per deployment; used
 *                  as a fallback so preview deployments work with no
 *                  extra configuration
 *   localhost    — last resort, for `next dev`
 *
 * Whatever this resolves to must ALSO be listed under Supabase →
 * Authentication → URL Configuration → Redirect URLs, or Supabase
 * refuses to redirect there and the emailed link dies at the Site URL.
 *
 * Moved here unchanged from the deleted lib/email/send-email.ts: it was
 * never Resend-specific — it answers "what is this deployment's origin",
 * which the Supabase Auth flow needs exactly as much as the old provider
 * boundary did.
 */
export function getAppUrl(): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return `https://${vercelUrl.replace(/\/+$/, "")}`;
  }

  return "http://localhost:3000";
}
