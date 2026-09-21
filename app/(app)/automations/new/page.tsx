import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { NewAutomation } from "@/features/automations/components/new-automation";

/**
 * New automation — the entry point that offers both creation paths.
 *
 * The two doors are rendered side by side with equal visual weight by
 * NewAutomation, and both lead into the same <AutomationBuilder> in the
 * same page. See that component for why this is one route rather than
 * two.
 */
export default async function NewAutomationPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const header = (
    <div>
      <Link
        href="/automations"
        className="text-xs font-semibold text-sky-600 underline-offset-2 transition-colors hover:underline"
      >
        &larr; All automations
      </Link>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">New automation</h1>
      <span
        aria-hidden="true"
        className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
      />
      <p className="mt-1.5 text-sm text-neutral-500">
        Two ways in, the same canvas either way. Nothing runs until you save it and switch it on.
      </p>
    </div>
  );

  if (membership.role !== "ADMIN") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="max-w-xl rounded-2xl bg-white p-6 text-sm text-neutral-600 shadow-sm ring-1 ring-black/5">
          Only an administrator can create automations.
        </div>
      </div>
    );
  }

  // The roster an assignment field may choose from — hierarchy-scoped
  // and Active-only by the RPC itself, resolved server-side. The client
  // never receives anyone the acting admin could not already see.
  const team = await getVisibleTeamDirectory(supabase);

  return (
    <div className="flex flex-col gap-6">
      {header}
      <NewAutomation team={team} />
    </div>
  );
}
