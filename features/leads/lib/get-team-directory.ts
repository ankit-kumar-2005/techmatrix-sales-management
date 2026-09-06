import type { SupabaseClient } from "@supabase/supabase-js";
import type { TeamDirectoryEntry } from "@/types/lead";

/**
 * Server-side only: the caller's own customer's active teammates
 * (id/email/role), via the get_customer_team_directory() RPC — the one
 * audited door onto auth.users, scoped to the caller's own customer
 * inside the function itself. Used for the Create Lead owner picker and
 * for resolving a manager_id to a display email on Profile. Never
 * exposes raw UUIDs to the UI — email is the display value.
 */
export async function getTeamDirectory(supabase: SupabaseClient): Promise<TeamDirectoryEntry[]> {
  const { data, error } = await supabase.rpc("get_customer_team_directory");

  if (error || !data) {
    return [];
  }

  return data as TeamDirectoryEntry[];
}

/**
 * Server-side only: the subset of the caller's own customer's active
 * teammates that the caller is authorized to see/act on under the
 * reporting hierarchy (customer_users.manager_id) — an ADMIN gets
 * everyone, everyone else gets themselves plus their recursive
 * manager_id descendants, via the get_visible_team_directory() RPC.
 * Used for the Pipeline Owner filter and the Create Lead Owner picker
 * (ADMIN only) — both must never surface a user outside the caller's
 * own branch. Deliberately a separate function from getTeamDirectory
 * above: that one is intentionally unrestricted (self + ancestors +
 * descendants effectively, since it's used to resolve the CALLER'S OWN
 * manager on Profile), and narrowing it would break that unrelated use.
 */
export async function getVisibleTeamDirectory(supabase: SupabaseClient): Promise<TeamDirectoryEntry[]> {
  const { data, error } = await supabase.rpc("get_visible_team_directory");

  if (error || !data) {
    return [];
  }

  return data as TeamDirectoryEntry[];
}
