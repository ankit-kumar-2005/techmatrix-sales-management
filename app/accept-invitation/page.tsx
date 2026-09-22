import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { MessageBanner } from "@/components/shared/message-banner";
import { AcceptInvitationForm } from "@/features/invitations/components/accept-invitation-form";
import { InvitationLinkHandler } from "@/features/invitations/components/invitation-link-handler";
import { getInvitationContext } from "@/features/invitations/lib/get-invitation-context";
import { getPendingInvitationIdForCurrentUser } from "@/features/invitations/lib/get-pending-invitation";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { BRAND_NAME } from "@/lib/brand";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AcceptInvitationPageProps = {
  searchParams: Promise<{ invitation_id?: string }>;
};

/**
 * THE invitation screen — and now the only one. The emailed link points
 * straight here (see sendInvitationLink); /accept-invitation/continue is
 * gone, along with the second component that used to reload this page
 * when a cookie lost a race. One route, one hand-off, one password step.
 *
 * Deliberately OUTSIDE the (app) route group — the person opening this
 * has no membership yet, which is the entire point — so it uses AuthShell,
 * the same frame /login, /signup, /set-password and /reset-password use.
 *
 * NO EMAIL IS EVER ASKED FOR HERE. Supabase verified the invited address
 * one click earlier; asking again would be a second, parallel signup.
 *
 * Nothing about the invitation is read for an unauthenticated visitor:
 * get_invitation_context returns nothing without a session, so a
 * link-holder learns no organization detail. A signed-in visitor whose
 * address does not match gets only that fact plus a masked hint. Every
 * decision that matters is re-made inside
 * accept_customer_user_invitation() against the caller's VERIFIED email.
 */
export default async function AcceptInvitationPage({ searchParams }: AcceptInvitationPageProps) {
  const params = await searchParams;
  const requestedId = params.invitation_id?.trim() ?? "";

  // Shape check only — a well-formed id that doesn't exist is deliberately
  // indistinguishable from one addressed to somebody else.
  const idFromUrl = UUID_PATTERN.test(requestedId) ? requestedId : null;

  if (requestedId && !idFromUrl) {
    return (
      <AuthShell title="Invitation link not valid" description="This link is missing or incomplete.">
        <MessageBanner tone="error">
          This invitation link isn&apos;t valid. Please use the link from your invitation email, or ask your
          administrator to send a new invitation.
        </MessageBanner>
      </AuthShell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No session VISIBLE TO THE SERVER. On a fresh click of the emailed
  // link that is the NORMAL first render: Supabase hands the session
  // over in the URL fragment, which is never sent to a server. Only the
  // browser can see it, so InvitationLinkHandler reads it, calls
  // setSession(), and reloads into the branch below. It also covers the
  // rarer case of a cookie that simply hasn't landed yet, and reports a
  // genuinely dead link honestly instead of starting a parallel signup.
  if (!user?.email) {
    return (
      <AuthShell
        title="Confirming your invitation"
        description="Just a moment while we confirm the link from your email."
      >
        <InvitationLinkHandler invitationId={idFromUrl ?? ""} />
      </AuthShell>
    );
  }

  // The id normally arrives in the link. It can be missing only when the
  // redirect that carried it was replaced by Supabase's Site-URL
  // fallback (see InvitationLinkFallback) — in which case the session
  // itself still identifies exactly one pending invitation, and this
  // SECURITY DEFINER lookup takes no parameters, so it can only ever
  // answer for the caller themselves.
  const invitationId = idFromUrl ?? (await getPendingInvitationIdForCurrentUser(supabase));

  if (!invitationId) {
    // Signed in, but with no invitation named and none waiting. Not a
    // dead end: send them wherever they actually belong. Only reachable
    // when the URL named no invitation at all — an explicit id is always
    // rendered below, whatever state it turns out to be in.
    const membership = await getCurrentMembership(supabase, user.id);
    redirect(membership ? "/sales-management" : "/set-password");
  }

  const context = await getInvitationContext(supabase, invitationId);
  const isWrongAccount = context !== null && !context.matchesCurrentUser;
  const isBlocked = context?.effectiveStatus != null && context.effectiveStatus !== "PENDING";

  return (
    <AuthShell
      title={
        isWrongAccount
          ? "Wrong account for this invitation"
          : isBlocked
            ? "Invitation not available"
            : "You're Invited"
      }
      description={
        isWrongAccount
          ? "You're signed in with an account this invitation wasn't sent to."
          : isBlocked
            ? "This invitation can no longer be used."
            : context?.companyName
              ? `You have been invited to join ${context.companyName} on ${BRAND_NAME}. Set a password to finish setting up your account.`
              : "Set a password to finish setting up your account."
      }
    >
      <AcceptInvitationForm invitationId={invitationId} authenticatedEmail={user.email} context={context} />
    </AuthShell>
  );
}
