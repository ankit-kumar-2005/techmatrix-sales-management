import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { LogoutButton } from "@/features/auth/components/logout-button";

/**
 * Landed on only by app/(app)/layout.tsx's own membership check — never
 * linked to directly. Deliberately outside the (app) route group: it
 * must not go through that same layout's guard itself, or an inactive
 * member would redirect-loop trying to reach the page that tells them
 * they're inactive.
 *
 * A directly-active member (or one with no membership at all) is sent
 * onward rather than shown this page — it exists for exactly one state:
 * authenticated, with a membership, and that membership is Inactive.
 */
export default async function InactivePage() {
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
  if (membership.membership.status === "Active") {
    redirect("/sales-management");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-50 px-6 py-16 text-center">
      <div className="w-full max-w-lg rounded-2xl bg-white p-10 shadow-xl shadow-sky-950/10 ring-1 ring-black/5">
        <h1 className="text-2xl font-bold text-neutral-900">Account inactive</h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-600">
          Your credentials are correct, but your account is currently inactive. Please contact your system
          administrator.
        </p>
        <div className="mt-8 flex justify-center">
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
