import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { NewPasswordForm } from "@/features/auth/components/new-password-form";

/**
 * Reachable only via a valid session, which at this point can only exist
 * because the user just verified their email through /auth/callback — a
 * user is never considered verified based on frontend state alone. A
 * direct, sessionless visit is sent back to /signup to start over.
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

  return (
    <AuthShell
      title="Set your password"
      description={`Email verified for ${user.email}. Choose a password to finish creating your account.`}
    >
      <NewPasswordForm
        submitLabel="Set Password"
        submittingLabel="Setting password..."
        successMessageKey="password_created"
      />
    </AuthShell>
  );
}
