import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { AppShell } from "@/features/sales-management/components/app-shell";

/**
 * Shared shell for every authenticated, customer-scoped route
 * (/sales-management, /settings/*). A route group ((app)) so these keep
 * their top-level URLs while sharing one guard + sidebar. Both checks —
 * session and customer membership — are server-side; see CLAUDE.md
 * Section G and the multi-tenant-security skill. There is no
 * Create-Organization-style onboarding page to redirect to anymore —
 * customer creation happens during signup (/set-password), so an
 * authenticated user with no membership is sent back to /signup to
 * restart that flow.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  // Correct email + correct password authenticates the person, but a
  // deactivated membership must never reach the app itself — checked
  // here (server-side, from the session-derived membership, never
  // client-supplied) because this layout already gates every
  // customer-scoped route in one place. Not a sign-out: the session
  // stays valid so /inactive can show who they are and offer to log
  // out, but no (app) route ever renders its real content for them.
  if (membership.membership.status !== "Active") {
    redirect("/inactive");
  }

  const customerName = membership.customer.company_name ?? membership.customer.email;
  const userEmail = user.email ?? membership.customer.email;
  const userAvatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null;

  return (
    <AppShell customerName={customerName} userEmail={userEmail} userAvatarUrl={userAvatarUrl}>
      {children}
    </AppShell>
  );
}
