/**
 * How a role name from the `roles` table is shown to a person. The
 * stored value (ADMIN / MANAGER / SENIOR_SALES_REP / SALES_REP) is never
 * changed — this is presentation only, and the roles table stays the
 * source of truth for which roles exist at all.
 *
 * Promoted here from app/(app)/settings/profile/page.tsx, which defined
 * this map locally when it was the only consumer. Settings → Add User
 * (its Role picker and its Invitation History rows) is the second, so
 * per this project's "start local, promote once actually reused"
 * convention it now lives in one place instead of two copies that could
 * drift into showing the same role two different ways on two screens.
 *
 * Falls back to the raw stored name for any role this map doesn't know,
 * so a role added to the table later still renders something sensible
 * rather than blank.
 */
const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrator",
  MANAGER: "Manager",
  SENIOR_SALES_REP: "Senior Sales Rep",
  SALES_REP: "Sales Rep",
};

export function formatRoleLabel(roleName: string | null | undefined): string {
  if (!roleName) return "—";
  return ROLE_LABELS[roleName] ?? roleName;
}
