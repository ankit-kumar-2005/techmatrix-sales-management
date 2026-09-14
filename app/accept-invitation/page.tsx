import { createClient } from "@/lib/supabase/server";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { MessageBanner } from "@/components/shared/message-banner";
import { AcceptInvitationForm } from "@/features/invitations/components/accept-invitation-form";
import { getInvitationContext } from "@/features/invitations/lib/get-invitation-context";
import { InvitationSessionRecovery } from "@/features/invitations/components/invitation-session-recovery";
import Link from "next/link";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AcceptInvitationPageProps = {
  searchParams: Promise<{ invitation_id?: string }>;
};

/**
 * Where an invited user finishes onboarding: set a password, accept, done.
 *
 * Deliberately OUTSIDE the (app) route group — the person opening this
 * has no membership yet, which is the entire point — so it uses AuthShell,
 * the same frame /login, /signup, /set-password and /reset-password use.
 *
 * THIS PAGE NO LONGER ASKS FOR AN EMAIL. It previously opened on an
 * email-entry step that sent a second verification email of its own; the
 * invitation email has already established and verified who was invited,
 * so the first thing the invitee now sees is the password form. Arriving
 * here without a server-visible session is treated as a recoverable
 * hand-off problem first (see the branch below) and only then reported,
 * rather than starting a parallel signup.
 *
 * Nothing about the invitation is read for an unauthenticated visitor:
 * get_invitation_context returns nothing without a session, so a
 * link-holder still learns no organization detail. A signed-in visitor
 * whose address does not match gets only that fact plus a masked hint.
 * Every decision that matters is re-made inside
 * accept_customer_user_invitation() against the caller's VERIFIED email.
 */
export default async function AcceptInvitationPage({ searchParams }: AcceptInvitationPageProps) {
  const params = await searchParams;
  const invitationId = params.invitation_id?.trim() ?? "";

  // Shape check only — a well-formed id that doesn't exist is deliberately
  // indistinguishable from one addressed to somebody else.
  if (!UUID_PATTERN.test(invitationId)) {
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

  // No session VISIBLE TO THE SERVER. That is not automatically the same
  // as "not signed in": the invitation session is established by the
  // browser client and stored in cookies, and that write can lose a race
  // with this navigation. InvitationSessionRecovery asks the browser
  // directly and reloads once if a session really is there, so a won
  // hand-off is never shown as a failure. If there genuinely is no
  // session, it renders nothing and this message stands.
  if (!user?.email) {
    return (
      <AuthShell
        title="Open the link from your email"
        description="Your invitation link signs you in, so this page needs to be opened from that email."
      >
        <div className="flex flex-col gap-4">
          <InvitationSessionRecovery />

          <MessageBanner tone="warning">
            <p>
              We couldn&rsquo;t confirm your sign-in. Invitation links work once, so this can happen if the
              link was already opened or has run out of time.
            </p>
            <p className="mt-1.5">
              Open the most recent invitation email, or ask your administrator to resend it.
            </p>
          </MessageBanner>

          <Link
            href="/login"
            className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-center text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
          >
            Already have a password? Log In
          </Link>
        </div>
      </AuthShell>
    );
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
            : "Set your password"
      }
      description={
        isWrongAccount
          ? "You're signed in with an account this invitation wasn't sent to."
          : isBlocked
            ? "This invitation can no longer be used."
            : context?.companyName
              ? `You've been invited to join ${context.companyName}. Choose a password to finish setting up your account.`
              : "Choose a password to finish setting up your account."
      }
    >
      <AcceptInvitationForm invitationId={invitationId} authenticatedEmail={user.email} context={context} />
    </AuthShell>
  );
}
