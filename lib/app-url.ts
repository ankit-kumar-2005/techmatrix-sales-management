/**
 * Where this deployment lives, as an absolute origin.
 *
 * SERVER-ONLY, and deliberately NOT a NEXT_PUBLIC_* variable: the
 * browser already knows its own origin (window.location.origin — what
 * every browser-initiated auth call in this app uses). This exists for
 * the one case that has no window: a Server Action asking Supabase Auth
 * to email somebody a link, where emailRedirectTo must be absolute.
 *
 * WHY THE ORDER BELOW MATTERS — this is what broke production invitations:
 *   APP_URL
 *     The stable public origin. Always prefer it.
 *   VERCEL_PROJECT_PRODUCTION_URL
 *     Vercel's STABLE production domain. Constant across deploys, so it
 *     can actually be allow-listed in Supabase once and stay valid.
 *   VERCEL_URL
 *     Vercel's PER-DEPLOYMENT hostname
 *     (my-app-git-abc123-team.vercel.app). It changes on EVERY deploy,
 *     which means it can never be reliably listed in Supabase's Redirect
 *     URLs. When Supabase is handed a redirect_to it does not recognise,
 *     it does not error — it silently redirects to the project's Site URL
 *     instead, which is exactly why clicking "Confirm email address"
 *     landed on the home page. Kept only as a last resort for preview
 *     deployments where a wildcard has been allow-listed on purpose.
 *   localhost
 *     For `next dev` only. Emailing this from a deployed environment
 *     produces a link nobody else can open, so callers refuse to send.
 *
 * Whatever this resolves to must ALSO be listed under Supabase →
 * Authentication → URL Configuration → Redirect URLs. A bare Site URL
 * does NOT cover deeper paths — allow-list the origin with `/**`.
 */
export type AppUrlSource = "APP_URL" | "VERCEL_PROJECT_PRODUCTION_URL" | "VERCEL_URL" | "localhost";

export type AppUrlResolution = {
  url: string;
  source: AppUrlSource;
  /** True when this origin is stable across deploys and can therefore be
   *  allow-listed in Supabase once. A per-deployment or localhost origin
   *  is not, and an emailed link built on one is unreliable by nature. */
  isStable: boolean;
};

export function resolveAppUrl(): AppUrlResolution {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    return { url: stripTrailingSlashes(configured), source: "APP_URL", isStable: true };
  }

  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (productionUrl) {
    return {
      url: `https://${stripTrailingSlashes(productionUrl)}`,
      source: "VERCEL_PROJECT_PRODUCTION_URL",
      isStable: true,
    };
  }

  const deploymentUrl = process.env.VERCEL_URL?.trim();
  if (deploymentUrl) {
    return {
      url: `https://${stripTrailingSlashes(deploymentUrl)}`,
      source: "VERCEL_URL",
      isStable: false,
    };
  }

  return { url: "http://localhost:3000", source: "localhost", isStable: false };
}

export function getAppUrl(): string {
  return resolveAppUrl().url;
}

/** True when this process is running somewhere other than a developer's
 *  machine, so a localhost link would be undeliverable in practice. */
export function isDeployedEnvironment(): boolean {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
