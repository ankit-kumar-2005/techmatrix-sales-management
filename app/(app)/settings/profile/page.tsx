import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { AvatarUpload } from "@/features/customers/components/avatar-upload";
import { LogoutButton } from "@/features/auth/components/logout-button";
import { LockIcon } from "@/features/sales-management/components/icons";

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

  const isActiveStatus = membership.membership.status === "Active";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Profile</h1>
        <p className="mt-1.5 text-sm text-neutral-500">Manage your account and workspace information.</p>
      </div>

      <div className="flex max-w-2xl flex-col gap-6">
        {/* Profile header */}
        <div className="relative overflow-hidden rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
          {/* Purely decorative brand accent — matches the card's own
              content height exactly (inset-y-0 within the padding box)
              so it's never cropped mid-figure at an arbitrary point, and
              a real mask-image fade (not just low opacity) blends its
              left edge into the white background instead of leaving a
              hard clipped line. It's a background layer independent of
              the real content's layout, not a flex item competing for
              space with the avatar/email/badge cluster. Hidden below
              md: where the card is too narrow for it to sit behind
              anything without crowding. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a static local SVG; next/image would need images.dangerouslyAllowSVG configured project-wide just for this one decorative asset */}
          <img
            src="/illustrations/profile-avatar.svg"
            alt=""
            aria-hidden="true"
            style={{
              maskImage: "linear-gradient(to right, transparent, black 65%)",
              WebkitMaskImage: "linear-gradient(to right, transparent, black 65%)",
            }}
            className="pointer-events-none absolute inset-y-0 right-0 hidden w-48 object-cover opacity-20 select-none md:block"
          />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
            <AvatarUpload userId={user.id} initialAvatarUrl={avatarUrl} initial={initial} />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-neutral-900" title={user.email}>
                {user.email}
              </p>
              <span className="mt-2 inline-block rounded-full bg-sky-50 px-3 py-1 text-[11px] font-semibold tracking-wider text-sky-700 uppercase ring-1 ring-sky-100">
                {membership.role}
              </span>
            </div>
          </div>
        </div>

        {/* Personal information */}
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
          <h2 className="text-xs font-semibold tracking-wider text-neutral-500 uppercase">
            Personal Information
          </h2>
          <dl className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Email</dt>
              <dd className="mt-1.5 truncate text-sm font-medium text-neutral-900">{user.email}</dd>
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-400">
                <LockIcon className="h-3 w-3 shrink-0" />
                Email cannot be changed
              </p>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Role</dt>
              <dd className="mt-1.5 text-sm font-medium text-neutral-900">
                {ROLE_LABELS[membership.role] ?? membership.role}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Company</dt>
              <dd className="mt-1.5 text-sm font-medium text-neutral-900">
                {membership.customer.company_name ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Manager</dt>
              <dd className="mt-1.5 text-sm font-medium text-neutral-900">{manager?.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Status</dt>
              <dd className="mt-1.5 flex items-center gap-1.5 text-sm font-medium text-neutral-900">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActiveStatus ? "bg-emerald-500" : "bg-neutral-300"}`}
                  aria-hidden="true"
                />
                {membership.membership.status}
              </dd>
            </div>
          </dl>
        </div>

        {/* Account information */}
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
          <h2 className="text-xs font-semibold tracking-wider text-neutral-500 uppercase">
            Account Information
          </h2>
          <dl className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Created</dt>
              <dd className="mt-1.5 text-sm font-medium text-neutral-900">
                {dateFormatter.format(new Date(membership.membership.created_at))}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Last Updated</dt>
              <dd className="mt-1.5 text-sm font-medium text-neutral-900">
                {dateFormatter.format(new Date(membership.membership.updated_at))}
              </dd>
            </div>
          </dl>
        </div>

        {/* Security */}
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
          <h2 className="text-xs font-semibold tracking-wider text-neutral-500 uppercase">Security</h2>

          <div className="mt-5 flex items-center justify-between gap-4 border-b border-neutral-100 pb-5">
            <div>
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Password</p>
              <p className="mt-1.5 text-sm font-medium tracking-widest text-neutral-900">••••••••••••</p>
            </div>
            <Link
              href="/forgot-password"
              className="min-h-10 shrink-0 rounded-full border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
            >
              Change Password
            </Link>
          </div>

          <div className="mt-5">
            <LogoutButton />
          </div>
        </div>
      </div>
    </div>
  );
}
