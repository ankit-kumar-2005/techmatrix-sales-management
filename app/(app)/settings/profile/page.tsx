import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { AvatarUpload } from "@/features/customers/components/avatar-upload";
import { LogoutButton } from "@/features/auth/components/logout-button";

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrator",
  MANAGER: "Manager",
  SENIOR_SALES_REP: "Senior Sales Rep",
  SALES_REP: "Sales Rep",
};

/**
 * Shows the user's real role (ADMIN/MANAGER/SENIOR_SALES_REP/SALES_REP)
 * — never "Primary Admin" as a role label. "Primary Admin" is a business
 * designation derived from customers.created_by === user.id, used for
 * authorization elsewhere (e.g. who can edit Company Information), not
 * a value that belongs on screen as if it were a role. See CLAUDE.md /
 * multi-tenant-security.
 *
 * There is no "full name" anywhere in this app's data model (only
 * auth.users.email) — this page identifies people by email throughout,
 * rather than inventing a name field that doesn't exist in the schema.
 */
export default async function ProfilePage() {
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

  const directory = membership.membership.manager_id ? await getTeamDirectory(supabase) : [];
  const manager = directory.find((entry) => entry.customer_user_id === membership.membership.manager_id);

  const initial = (user.email ?? "?").charAt(0).toUpperCase();
  const avatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Profile</h1>
        <p className="mt-1 text-sm text-neutral-600">Manage your account and workspace information.</p>
      </div>

      <div className="max-w-2xl rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
        {/* Profile header */}
        <div className="flex flex-col gap-4 border-b border-neutral-100 p-6 sm:flex-row sm:items-center sm:p-8">
          <AvatarUpload userId={user.id} initialAvatarUrl={avatarUrl} initial={initial} />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-neutral-900">{user.email}</p>
            <span className="mt-1 inline-block rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700">
              {membership.role}
            </span>
          </div>
        </div>

        {/* Personal / account information */}
        <div className="border-b border-neutral-100 p-6 sm:p-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Personal Information
          </h2>
          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Email</dt>
              <dd className="mt-1 truncate text-sm text-neutral-900">{user.email}</dd>
              <p className="mt-1 text-xs text-neutral-400">🔒 Email cannot be changed</p>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Role</dt>
              <dd className="mt-1 text-sm text-neutral-900">{ROLE_LABELS[membership.role] ?? membership.role}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Company</dt>
              <dd className="mt-1 text-sm text-neutral-900">{membership.customer.company_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Manager</dt>
              <dd className="mt-1 text-sm text-neutral-900">{manager?.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Status</dt>
              <dd className="mt-1 text-sm text-neutral-900">{membership.membership.status}</dd>
            </div>
          </dl>
        </div>

        {/* Account information */}
        <div className="border-b border-neutral-100 p-6 sm:p-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Account Information
          </h2>
          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Created</dt>
              <dd className="mt-1 text-sm text-neutral-900">
                {dateFormatter.format(new Date(membership.membership.created_at))}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">Last Updated</dt>
              <dd className="mt-1 text-sm text-neutral-900">
                {dateFormatter.format(new Date(membership.membership.updated_at))}
              </dd>
            </div>
          </dl>
        </div>

        {/* Security */}
        <div className="border-b border-neutral-100 p-6 sm:p-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Security</h2>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Password</p>
              <p className="mt-1 text-sm text-neutral-900">••••••••••••</p>
            </div>
            <Link
              href="/forgot-password"
              className="min-h-10 shrink-0 rounded-full border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-50"
            >
              Change Password
            </Link>
          </div>
        </div>

        <div className="p-6 sm:p-8">
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}
