import { AuthShell } from "@/features/auth/components/auth-shell";
import { CompleteInvitationLink } from "@/features/invitations/components/complete-invitation-link";

type ContinueInvitationPageProps = {
  searchParams: Promise<{ invitation_id?: string }>;
};

/**
 * Where the emailed invitation link lands (emailRedirectTo in
 * sendInvitationLink). Its only job is to let the browser finish the
 * Supabase Auth hand-off that the server cannot see, then forward to
 * /accept-invitation — see CompleteInvitationLink for why that split is
 * necessary rather than tidy.
 *
 * No validation happens here on purpose: the invitation id is forwarded
 * untouched to /accept-invitation, which already owns the shape check
 * and is the only place that hands the id to the acceptance RPC. One
 * validator, one authority — a second copy here could only drift.
 */
export default async function ContinueInvitationPage({ searchParams }: ContinueInvitationPageProps) {
  const params = await searchParams;

  return (
    <AuthShell
      title="Verifying your invitation"
      description="Just a moment while we confirm the link from your email."
    >
      <CompleteInvitationLink invitationId={params.invitation_id?.trim() ?? ""} />
    </AuthShell>
  );
}
