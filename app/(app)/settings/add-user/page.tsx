import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { FormField } from "@/components/shared/form-field";

/**
 * UI structure only — no invitation logic. This will connect to a
 * future customer_invitations table (create invite -> send email ->
 * accept -> auth user + customer_users created) in a later phase;
 * wiring that up is explicitly out of scope for this one. See CLAUDE.md
 * Section 7 (phase-based development).
 */
export default async function AddUserPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  if (!membership.isPrimaryAdmin) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-neutral-900">Add User</h1>
        <div className="max-w-xl rounded-2xl bg-white p-6 text-sm text-neutral-600 shadow-sm ring-1 ring-black/5">
          Only the Primary Admin can add users to this account.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Add User</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Invite a new team member
          {membership.customer.company_name ? ` to ${membership.customer.company_name}` : ""}.
        </p>
      </div>

      <div className="max-w-xl rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <form className="flex flex-col gap-4">
          <FormField label="Full Name" name="fullName" required placeholder="Jane Doe" disabled />
          <FormField label="Email" name="email" type="email" required placeholder="jane@example.com" disabled />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="role" className="text-sm font-medium text-neutral-700">
              Role
            </label>
            <select
              id="role"
              name="role"
              disabled
              className="rounded-lg border border-neutral-300 px-3.5 py-2.5 text-sm text-neutral-900 outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
              defaultValue="SALES_REP"
            >
              <option value="ADMIN">Admin</option>
              <option value="MANAGER">Manager</option>
              <option value="SENIOR_SALES_REP">Senior Sales Rep</option>
              <option value="SALES_REP">Sales Rep</option>
            </select>
          </div>

          <p role="status" className="rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-800 ring-1 ring-sky-200">
            Invitations aren&apos;t enabled yet — this will send an email invite once the
            invitation system is connected in a later phase.
          </p>

          <button
            type="button"
            disabled
            className="min-h-11 self-start rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white opacity-60 cursor-not-allowed"
          >
            Send Invitation
          </button>
        </form>
      </div>
    </div>
  );
}
