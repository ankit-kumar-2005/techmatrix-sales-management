import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getLeadStagesForCustomer } from "@/features/leads/lib/get-lead-stages";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { AppShell } from "@/features/sales-management/components/app-shell";
import { AssistantLauncher } from "@/features/assistant/components/assistant-launcher";

/**
 * Shared shell for every authenticated, customer-scoped route
 * (/sales-management, /settings/*). A route group ((app)) so these keep
 * their top-level URLs while sharing one guard + sidebar. Both checks —
 * session and customer membership — are server-side; see CLAUDE.md
 * Section G and the multi-tenant-security skill.
 *
 * There is no Create-Organization-style onboarding page to redirect to —
 * customer creation happens during signup (/set-password). So an
 * authenticated user with NO membership row is sent back to /signup to
 * restart that flow, while a user whose membership exists but has been
 * DEACTIVATED goes to /inactive. Those two used to be the same redirect,
 * which is the bug getNoMembershipRedirect documents.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await getAuthenticatedUser(supabase);

  if (error || !user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    // WHY THE STATE IS RE-READ INSTEAD OF JUST REDIRECTING TO /signup:
    // getCurrentMembership() returns null for two completely different
    // people, and they must not be sent to the same place.
    //
    // A DEACTIVATED member has an account. Sending them to "Create your
    // account" was the reported "reset my password, log in, end up on
    // Signup" bug — and /signup leads to /set-password, which calls
    // create_customer_with_admin() and would give them a second customer
    // they never asked for. They belong on /inactive — which is what
    // the `membership.membership.status !== "Active"` check that used to
    // sit just below here always meant to do, and could never do: a
    // non-null membership is Active by construction, so that branch was
    // unreachable and the Inactive case fell through to /signup instead.
    // It has been removed; this is where that decision lives now.
    //
    // Someone with NO membership row genuinely still has registration to
    // finish, so /signup stays correct for them — unchanged behaviour.
    //
    // Costs no extra query for the normal case: getNoMembershipRedirect
    // reuses this same cache()d getCurrentMembership call, and only
    // queries again on this already-redirecting path. Every (app) page
    // calls the same helper, so this guard and theirs cannot disagree.
    //
    // Not a sign-out: the session stays valid so /inactive can show who
    // they are and offer to log out, but no (app) route ever renders its
    // real content for them.
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const customerName = membership.customer.company_name ?? membership.customer.email;
  const userEmail = user.email ?? membership.customer.email;
  const userAvatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null;

  // Fetched once, here, for the AI assistant's floating launcher —
  // mounted globally below (a sibling of AppShell, not inside it, so
  // AppShell itself needed no changes at all) so it's available on
  // every authenticated page, matching the reference screenshots' own
  // widget being present everywhere regardless of the current page.
  // Same two calls, same RPCs, every other page that needs a stage
  // picker or a team/owner picker already makes (CreateLeadDialog's own
  // `stages`/`owners`, AddTaskDialog's/NewContactDialog's own
  // `assignableUsers`) — no new data-fetching mechanism.
  const [stages, teamDirectory] = await Promise.all([
    getLeadStagesForCustomer(supabase, membership.customer.id),
    getVisibleTeamDirectory(supabase),
  ]);

  return (
    <>
      <AppShell customerName={customerName} userEmail={userEmail} userAvatarUrl={userAvatarUrl}>
        {children}
      </AppShell>
      {/* A SIBLING of AppShell, not a child inside its JSX — the
          floating launcher is a fixed-position overlay independent of
          AppShell's own sidebar/content layout, so mounting it here
          needed zero changes to AppShell itself. */}
      <AssistantLauncher
        stages={stages}
        teamDirectory={teamDirectory}
        role={membership.role}
        currentUserEmail={userEmail}
        currentUserCustomerUserId={membership.membership.id}
        // Same field the Profile page's own "Name" row already reads
        // (customer_users.name, set once at signup) — reused here to
        // personalize the assistant's opening greeting, never a second
        // way of resolving who's logged in. May be null for a member
        // who never set a name; the launcher falls back to their email
        // for that case, the same way this app's owner/assignee labels
        // already do (features/leads/lib/owner-display.ts).
        currentUserName={membership.membership.name}
      />
    </>
  );
}
