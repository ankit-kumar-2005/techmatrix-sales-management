import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { getAssignableRoles } from "@/features/invitations/lib/get-roles";
import { getInvitationsPage } from "@/features/invitations/lib/get-invitations";
import { AddUserPageClient } from "@/features/invitations/components/add-user-page-client";

const INITIAL_PAGE_SIZE = 10;

/**
 * Settings → Add User. Auth + customer membership are already guarded by
 * app/(app)/layout.tsx before this page renders (see every other page in
 * this route group's identical note) — this page adds the ADMIN check
 * and fetches what the UI needs.
 *
 * ROLE GATE CHANGED FROM THE PREVIOUS PLACEHOLDER, deliberately: the
 * disabled stub this replaces gated on `isPrimaryAdmin`
 * (customers.created_by — the one person who originally registered the
 * company). Every piece of the invitation backend that actually exists
 * now authorizes the ADMIN *role* instead: createInvitationAction,
 * resendInvitationAction and cancelInvitationAction all check
 * `membership.role !== "ADMIN"`, and RLS on customer_user_invitations
 * uses is_customer_admin(). Keeping the Primary-Admin gate here would
 * have told a legitimate second ADMIN they lack permission while the
 * server happily accepted their invitations — a UI that contradicts its
 * own backend. This aligns the page with the rule the server actually
 * enforces; it does not grant anything the server wouldn't already
 * allow, and it is a UX gate either way: RLS remains the boundary.
 *
 * Page 1 of the invitation history is fetched here so first paint has no
 * loading flash. Every later page/search/filter change is fetched by
 * InvitationList itself through getInvitationsPageAction — genuinely
 * server-side, never the whole table sliced in the browser.
 */
export default async function AddUserPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    // /inactive for a DEACTIVATED member, /signup only for someone with
    // no membership row at all. One shared decision so this guard and
    // the (app) layout's cannot disagree — see getNoMembershipRedirect.
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  if (membership.role !== "ADMIN") {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Add User</h1>
          <span
            aria-hidden="true"
            className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
          />
        </div>
        <div className="max-w-xl rounded-2xl bg-white p-6 text-sm text-neutral-600 shadow-sm ring-1 ring-black/5">
          Only an administrator can invite users to this organization.
        </div>
      </div>
    );
  }

  // Roles and the manager directory are both small, bounded reads. The
  // team directory comes from the existing get_visible_team_directory()
  // RPC, which returns only ACTIVE members of the caller's own customer
  // — so every manager option is valid by construction, and no other
  // tenant's users can appear in the picker.
  const [initialPage, roles, managerOptions] = await Promise.all([
    getInvitationsPage(supabase, membership.customer.id, {
      search: "",
      status: "",
      page: 0,
      pageSize: INITIAL_PAGE_SIZE,
    }),
    getAssignableRoles(supabase),
    getVisibleTeamDirectory(supabase),
  ]);

  return <AddUserPageClient initialPage={initialPage} roles={roles} managerOptions={managerOptions} />;
}
