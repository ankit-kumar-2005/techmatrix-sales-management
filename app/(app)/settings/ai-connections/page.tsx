import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { AiConnectionsAdmin } from "@/features/mcp/components/ai-connections-admin";
import { getAiConnectionsAdminData } from "@/features/mcp/lib/admin-data";
import { getMcpResourceUrl } from "@/features/mcp/lib/urls";
import { BRAND_NAME } from "@/lib/brand";

function PageHeading() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">AI Connections</h1>
      <span aria-hidden="true" className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600" />
    </div>
  );
}

/**
 * Settings → AI Connections (admins). Same guard shape as Add User: auth
 * and membership are already enforced by app/(app)/layout.tsx, this page
 * adds the ADMIN role check (UX layer — the admin-only RLS on the MCP
 * settings tables, and the server actions' own checks, are the boundary).
 */
export default async function AiConnectionsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) redirect(await getNoMembershipRedirect(supabase, user.id));

  if (membership.role !== "ADMIN") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeading />
        <div className="max-w-xl rounded-2xl bg-white p-6 text-sm text-neutral-600 shadow-sm ring-1 ring-black/5">
          Only an administrator can manage AI connections for this organization. You can see and disconnect your own AI apps
          under Settings → My AI Connections.
        </div>
      </div>
    );
  }

  const data = await getAiConnectionsAdminData(supabase, membership.customer.id, membership.membership.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading />
      <AiConnectionsAdmin
        data={data}
        serverUrl={getMcpResourceUrl()}
        serverSlug={BRAND_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
        nowMs={new Date().getTime()}
      />
    </div>
  );
}
