import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/features/auth/components/logout-button";
import { BRAND_NAME } from "@/lib/brand";

/**
 * Protected route. Uses supabase.auth.getUser() (not getSession()) because
 * it revalidates the token against the Supabase Auth server rather than
 * only trusting what's in the cookie — the correct check for a
 * server-side authorization decision. See CLAUDE.md Section H.
 */
export default async function ProfilePage() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-50 px-6 py-16 text-center">
      <div className="w-full max-w-lg rounded-2xl bg-white p-10 shadow-xl shadow-sky-950/10 ring-1 ring-black/5">
        <h1 className="text-2xl font-bold text-neutral-900">
          Welcome {user.email} to {BRAND_NAME}
        </h1>
        <p className="mt-2 text-sm text-neutral-600">Email: {user.email}</p>
        <div className="mt-8 flex justify-center">
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
