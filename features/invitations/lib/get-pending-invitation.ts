import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side only: the id of a pending invitation waiting for the
 * CURRENT user, or null.
 *
 * Thin wrapper around get_pending_invitation_for_current_user(), which
 * takes no parameters — the caller's identity comes from auth.uid()
 * inside the function, so there is nothing here that could be pointed at
 * somebody else's invitation. See that migration for the full security
 * note on why a SECURITY DEFINER function is required (RLS on
 * customer_user_invitations is ADMIN-only, so an invitee cannot read
 * their own row).
 *
 * FAILS OPEN, deliberately. This is used to REROUTE a user away from
 * normal signup, not to authorize anything — every real decision is
 * still made by accept_customer_user_invitation() and by RLS. If the
 * function is missing (migration not yet applied) or the call fails,
 * returning null means signup behaves exactly as it does today rather
 * than a new lookup being able to block registration outright. A
 * rerouting hint must never become a single point of failure for
 * creating an account.
 */
export async function getPendingInvitationIdForCurrentUser(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_pending_invitation_for_current_user");

  if (error) {
    return null;
  }

  return typeof data === "string" && data.length > 0 ? data : null;
}
