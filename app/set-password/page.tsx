import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getPendingInvitationIdForCurrentUser } from "@/features/invitations/lib/get-pending-invitation";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { SetPasswordForm } from "@/features/auth/components/set-password-form";

/**
 * Reachable only via a valid session, which at this point can only exist
 * because the user just verified their email through /auth/callback — a
 * user is never considered verified based on frontend state alone. A
 * direct, sessionless visit is sent back to /signup to start over.
 *
 * Email verification alone doesn't mean registration is complete —
 * that's only true once customer_users exists (created by this page's
 * own form on successful submit). /auth/callback already redirects an
 * already-registered user away from here in the normal case, but this
 * is the second, independent check for anyone who reaches this URL
 * another way (a bookmark, browser back button, a stale tab) — same
 * customer_users relationship, no new table.
 */
export default async function SetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/signup");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (membership) {
    redirect("/sales-management");
  }

  // INVITED USERS MUST NOT LAND HERE. This page's form finishes normal
  // registration by calling create_customer_with_admin(), which creates
  // a BRAND NEW customer with this user as its ADMIN. For somebody who
  // was invited into an EXISTING organization that is the wrong outcome
  // twice over: it manufactures a second tenant nobody asked for, and
  // the one-active-membership-per-user rule then makes their real
  // invitation permanently unacceptable ("This account already belongs
  // to an organization").
  //
  // It is reachable: an invited person who ignores the invitation email
  // and signs up normally instead verifies their address through
  // /auth/callback?next=/set-password like any other new user. Nothing
  // downstream could tell the two apart, because RLS hides the
  // invitation from the invitee — hence the SECURITY DEFINER lookup.
  //
  // Ordered AFTER the membership check on purpose: an existing member
  // who happens to also hold a pending invitation elsewhere keeps the
  // established behavior (straight into the app) rather than being
  // pulled into an acceptance flow they didn't ask for.
  //
  // The acceptance page opens directly on its own password form, so no
  // hint needs to travel with this redirect: it always offers password
  // setup, and accept_customer_user_invitation() re-validates everything
  // that matters regardless.
  const pendingInvitationId = await getPendingInvitationIdForCurrentUser(supabase);
  if (pendingInvitationId) {
    redirect(`/accept-invitation?invitation_id=${encodeURIComponent(pendingInvitationId)}`);
  }

  return (
    <AuthShell
      title="Set your password"
      description={`Email verified for ${user.email}. Choose a password to finish creating your account.`}
      step={{ current: 2, total: 2 }}
    >
      <SetPasswordForm />
    </AuthShell>
  );
}
