import type { SupabaseClient } from "@supabase/supabase-js";

/** Just what a Role picker needs. The `roles` table is fixed reference
 *  data managed only by migrations, so this is a tiny, unfiltered-by-
 *  tenant read — roles are global, not per-customer. */
export type AssignableRole = {
  id: string;
  name: string;
};

/**
 * Server-side only: every role that can currently be assigned, ordered
 * by the seeded hierarchy (ADMIN → MANAGER → SENIOR_SALES_REP →
 * SALES_REP) rather than alphabetically, so a picker reads top-down the
 * way the org chart does.
 *
 * Only Active roles are returned: the invitation table's own validation
 * trigger rejects an invitation into a retired role, so offering one in
 * the UI could only ever produce a failed submit. RLS ("authenticated
 * users can view roles", using(true)) already allows this read for any
 * signed-in user — no new policy, no SECURITY DEFINER helper.
 *
 * The UI submits roles.id, never a role NAME: names are display text
 * (see formatRoleLabel), and the database's own foreign key is what
 * makes an unknown id impossible.
 */
const ROLE_ORDER = ["ADMIN", "MANAGER", "SENIOR_SALES_REP", "SALES_REP"];

export async function getAssignableRoles(supabase: SupabaseClient): Promise<AssignableRole[]> {
  const { data, error } = await supabase.from("roles").select("id, name").eq("status", "Active");

  if (error || !data) {
    return [];
  }

  const roles = data as AssignableRole[];

  return [...roles].sort((a, b) => {
    const aIndex = ROLE_ORDER.indexOf(a.name);
    const bIndex = ROLE_ORDER.indexOf(b.name);
    // Anything outside the seeded four (a role added later) sorts after
    // them, alphabetically among itself, rather than silently jumping to
    // the top of the list.
    if (aIndex === -1 && bIndex === -1) return a.name.localeCompare(b.name);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });
}
