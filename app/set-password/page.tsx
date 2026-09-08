import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
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
