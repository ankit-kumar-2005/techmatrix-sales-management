import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

// api/mcp and .well-known are excluded: they authenticate with a bearer
// token, never a cookie session, so refreshing a session cookie there
// would only add an auth round trip to every MCP call.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|icon.png|api/mcp|\\.well-known|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
