import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the acceptance page is allowed to know about an invitation.
 *
 * Everything except `matchesCurrentUser` and `invitedEmailHint` is null
 * unless the signed-in account IS the invited one — the database decides
 * that, not this module. See the migration's graduated-disclosure note.
 */
export type InvitationContext = {
  matchesCurrentUser: boolean;
  /** Always masked (r***l@acme.com), never the full address. */
  invitedEmailHint: string | null;
  /** The name the admin entered in Add User — the same value the
   *  acceptance RPC copies into customer_users.name, so the screen
   *  cannot show one name and create another. */
  invitedFullName: string | null;
  companyName: string | null;
  roleName: string | null;
  managerName: string | null;
  /** PENDING / ACCEPTED / CANCELLED / EXPIRED — only when matched. */
  effectiveStatus: string | null;
};

type InvitationContextRow = {
  matches_current_user: boolean | null;
  invited_email_hint: string | null;
  invited_full_name: string | null;
  company_name: string | null;
  role_name: string | null;
  manager_name: string | null;
  effective_status: string | null;
};

/**
 * Server-side only. Returns null when there is no session, when the
 * invitation id matches nothing, or when the call fails.
 *
 * FAILS OPEN on purpose: this drives DISPLAY only. If the function is
 * missing (migration not yet applied) the page falls back to exactly the
 * behaviour it had before, rather than a display lookup being able to
 * block acceptance outright. Authorization is unaffected either way —
 * accept_customer_user_invitation() re-validates everything.
 */
export async function getInvitationContext(
  supabase: SupabaseClient,
  invitationId: string,
): Promise<InvitationContext | null> {
  const { data, error } = await supabase.rpc("get_invitation_context", {
    p_invitation_id: invitationId,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  const row = data[0] as InvitationContextRow;

  return {
    matchesCurrentUser: row.matches_current_user === true,
    invitedEmailHint: row.invited_email_hint,
    invitedFullName: row.invited_full_name,
    companyName: row.company_name,
    roleName: row.role_name,
    managerName: row.manager_name,
    effectiveStatus: row.effective_status,
  };
}
