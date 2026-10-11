import type { NextConfig } from "next";

/**
 * The OAuth consent screen must never be framed by another site: a page
 * that frames it could trick a signed-in person into clicking "Allow"
 * (clickjacking; RFC 6749 §10.13). Scoped to /oauth/* only, so no other
 * page's behaviour changes. Both headers are sent: frame-ancestors is the
 * modern control, X-Frame-Options covers older browsers.
 */
export const OAUTH_ANTI_FRAMING_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/oauth", headers: OAUTH_ANTI_FRAMING_HEADERS },
      { source: "/oauth/:path*", headers: OAUTH_ANTI_FRAMING_HEADERS },
    ];
  },
};

export default nextConfig;
