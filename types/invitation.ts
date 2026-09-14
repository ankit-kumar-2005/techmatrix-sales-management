/** Fixed vocabulary, CHECK-constrained in the database (see the
 *  customer_user_invitations migration) — not customer-configurable, so
 *  a plain union is the right shape here, same reasoning as
 *  types/task.ts's TASK_STATUSES.
 *
 *  Deliberately UPPERCASE while every membership/record status in this
 *  app is Title case ('Active'/'Inactive', 'Pending'/'Completed'): an
 *  INVITATION status and a MEMBERSHIP status are different concepts and
 *  must never be compared to or mistaken for each other. */
export const INVITATION_STATUSES = ["PENDING", "ACCEPTED", "EXPIRED", "CANCELLED"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** What the Invitation History list shows in its Membership column. The
 *  first two are read live from customer_users; the third is the absence
 *  of a membership row, never a stored value and never a placeholder row
 *  in customer_users. */
export type InvitationMembershipStatus = "Active" | "Inactive" | "Not yet a member";

/** A row from public.customer_user_invitations. */
export type CustomerUserInvitation = {
  id: string;
  customer_id: string;
  email: string;
  full_name: string;
  role_id: string;
  manager_id: string | null;
  invited_by: string;
  status: InvitationStatus;
  invited_at: string;
  last_sent_at: string;
  accepted_at: string | null;
  expires_at: string;
  /** Set by accept_customer_user_invitation() to the membership that
   *  invitation produced. Null for every invitation that hasn't been
   *  accepted — which is exactly how "Not yet a member" is derived,
   *  with no duplicated status column. */
  accepted_customer_user_id: string | null;
  created_at: string;
  updated_at: string;
};
