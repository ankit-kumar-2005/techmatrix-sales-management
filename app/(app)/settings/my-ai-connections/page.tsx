import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { MyAiConnections } from "@/features/mcp/components/my-ai-connections";
import { getMyAiConnections } from "@/features/mcp/lib/admin-data";

/**
 * Settings → My AI Connections (every member): the AI apps this person
 * has authorized, when they were last used, and Disconnect. Shows only
 * the caller's own grants (Supabase listGrants is per user) and own rows.
 */
export default async function MyAiConnectionsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);
  if (!user) redirect("/login");

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) redirect(await getNoMembershipRedirect(supabase, user.id));

  const connections = await getMyAiConnections(supabase, membership.membership.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">My AI Connections</h1>
        <span aria-hidden="true" className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600" />
      </div>
      <MyAiConnections connections={connections} nowMs={new Date().getTime()} />
    </div>
  );
}
