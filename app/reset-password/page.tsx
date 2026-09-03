import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { NewPasswordForm } from "@/features/auth/components/new-password-form";

/**
 * Reachable only via a valid session, which at this point can only exist
 * because the user just came from a Supabase password-recovery link
 * through /auth/callback. A direct, sessionless visit is sent back to
 * /forgot-password to start over — see CLAUDE.md Section H.
 */
export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/forgot-password");
  }

  return (
    <AuthShell title="Set a new password" description={`Choose a new password for ${user.email}.`}>
      <NewPasswordForm
        submitLabel="Reset Password"
        submittingLabel="Resetting password..."
        successMessageKey="password_reset"
      />
    </AuthShell>
  );
}
