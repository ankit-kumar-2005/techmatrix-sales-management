"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { createInvitationSchema } from "./schemas";
import {
  findPendingInvitationByEmail,
  getInvitationsPage,
  type InvitationsPage,
  type InvitationsPageParams,
} from "./lib/get-invitations";
import { sendInvitationLink } from "./lib/send-invitation-link";
import type { InvitationActionResult, InvitationFormState } from "./form-state";

/** Server-side resend throttle. The UI's own 60-second countdown is a
 *  convenience, never the control: this is checked here, on the server,
 *  against last_sent_at read fresh from the database on every call.
 *
 *  Deliberately NOT also enforced by a database trigger. The thing being
 *  rate-limited is SENDING AN EMAIL, and that only ever happens on this
 *  path — an admin bypassing this action to UPDATE last_sent_at directly
 *  through PostgREST would move a timestamp and send nothing, so a
 *  trigger would be guarding the wrong resource. If email sending ever
 *  moves into the database (it won't), this moves with it. */
const RESEND_COOLDOWN_SECONDS = 60;

/** How long a fresh or resent invitation stays valid. Matches the
 *  column default in the customer_user_invitations migration and
 *  Supabase's own default email-link validity — kept here as well
 *  because a RESEND has to move expires_at explicitly (a column default
 *  only applies on INSERT). */
const INVITATION_VALIDITY_MINUTES = 60;

/** Every error text the acceptance RPC and the invitation triggers can
 *  raise, mapped to what a person should actually read. Matching on a
 *  substring of the database's message is the convention this project
 *  already uses for exactly this (SetPasswordForm matches
 *  create_customer_with_admin's "already belongs to a customer"), and
 *  the migrations document those strings as stable for that reason. Raw
 *  Postgres text is never returned to the caller — CLAUDE.md Section K. */
function translateDatabaseError(message: string): string {
  if (message.includes("already a member of this customer")) {
    return "User already exists with this email address. Please use a different email.";
  }
  if (message.includes("manager must be an active member")) {
    return "The selected manager is no longer active. Choose a different manager.";
  }
  if (message.includes("role is not available") || message.includes("role on this invitation")) {
    return "The selected role is not available. Choose a different role.";
  }
  if (message.includes("customer_user_invitations_unique_pending_email_per_customer")) {
    return "An invitation is already pending for this email address.";
  }
  if (message.includes("not valid for your account")) {
    return "This invitation is not valid for your account.";
  }
  if (message.includes("already been accepted")) {
    return "This invitation has already been accepted.";
  }
  if (message.includes("has been cancelled")) {
    return "This invitation has been cancelled.";
  }
  if (message.includes("has expired")) {
    return "This invitation has expired. Ask your administrator to send a new one.";
  }
  if (message.includes("already belongs to an organization")) {
    return "This account already belongs to an organization.";
  }
  return "Something went wrong. Please try again.";
}

/**
 * ADMIN-role-gated exactly like createCatalogItemAction: auth check,
 * membership check, role check. That role check is the UX layer only —
 * RLS ("admins can create invitations for their customer", via the
 * existing is_customer_admin() helper) is the real boundary and holds
 * even if this check were removed or bypassed by a direct API call.
 *
 * customer_id is never read from the form — always derived from the
 * caller's own membership (CLAUDE.md Section G), so a crafted request
 * cannot invite somebody into another tenant.
 *
 * DUPLICATE HANDLING, in the order it matters:
 *   1. An existing PENDING invitation for the same customer + normalized
 *      email is found FIRST and reported as `alreadyPending` with its id,
 *      rather than being allowed to hit the unique index. Resend is the
 *      correct next action, and deliberately NOT performed automatically
 *      here — that would silently bypass the 60-second cooldown and send
 *      an email the admin didn't ask for. This also covers an invitation
 *      that has run past expires_at but is still stored as PENDING:
 *      resending it refreshes expires_at and revives it, so an expired
 *      invitation never becomes a dead end that blocks the address.
 *   2. An email that already belongs to a member of THIS customer is
 *      rejected by the database's own validation trigger, translated
 *      here into the specified message. That check is tenant-scoped by
 *      design: it tells an admin about their own organization and leaks
 *      nothing about any other tenant's users.
 *   3. An email that exists in auth.users but belongs to no membership
 *      here is deliberately NOT blocked. Blocking it would both leak
 *      cross-tenant user existence and falsely reject a legitimate
 *      invitee who has an account but no active membership anywhere.
 *      The one-active-membership rule is enforced where it actually
 *      applies — at acceptance, by accept_customer_user_invitation() and
 *      the unique index behind it.
 */
export async function createInvitationAction(
  _prevState: InvitationFormState,
  formData: FormData,
): Promise<InvitationFormState> {
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
  if (membership.role !== "ADMIN") {
    return { formError: "You do not have permission to perform this action." };
  }

  const parsed = createInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const existingPending = await findPendingInvitationByEmail(
    supabase,
    membership.customer.id,
    parsed.data.email,
  );
  if (existingPending) {
    return {
      formError: "An invitation is already pending for this email address. Resend it instead.",
      alreadyPending: { invitationId: existingPending.id },
    };
  }

  const { data: created, error } = await supabase
    .from("customer_user_invitations")
    .insert({
      customer_id: membership.customer.id,
      email: parsed.data.email,
      full_name: parsed.data.full_name,
      role_id: parsed.data.role_id,
      manager_id: parsed.data.manager_id ?? null,
      invited_by: user.id,
      // status/invited_at/last_sent_at/expires_at all take their column
      // defaults — PENDING, now(), now(), now() + 1 hour.
    })
    .select("id")
    .maybeSingle();

  if (error) {
    return { formError: translateDatabaseError(error.message) };
  }
  if (!created) {
    return { formError: "Unable to create this invitation. Please try again." };
  }

  const emailResult = await sendInvitationLink({
    invitationId: created.id as string,
    email: parsed.data.email,
  });

  revalidatePath("/settings/add-user");

  // The invitation row IS created either way — it is a real, resendable
  // PENDING invitation, and this table has no DELETE grant by design
  // (invitations are history), so a failed send is reported honestly
  // rather than rolled back or silently swallowed. The admin's next
  // action is Resend, which is also what re-sends the email.
  if (!emailResult.sent) {
    return {
      success: true,
      formError:
        emailResult.reason === "confirmation_disabled"
          ? "Invitation created, but no email was sent: email confirmation is turned off for this project."
          : "Invitation created, but the invitation email could not be sent. Use Resend to try again.",
    };
  }

  return { success: true };
}

/**
 * Reuses the existing invitation row — never creates a second PENDING
 * one (the partial unique index would reject it anyway). Only a PENDING
 * invitation can be resent: an accepted, cancelled or already-expired-
 * and-marked one is a terminal state, and reviving it would be a new
 * invitation, which is what Create is for.
 *
 * expires_at IS extended on every resend, deliberately: the resent email
 * carries a fresh link, so leaving the original deadline in place would
 * hand the invitee a link that dies sooner than the message implies —
 * and it is what lets a still-PENDING invitation that ran past its
 * deadline be revived rather than blocking that email address forever.
 *
 * The cooldown is measured from last_sent_at as stored in the database,
 * re-read on every call, so it cannot be defeated by a stale client, a
 * second tab, or a crafted request that skips the UI entirely.
 */
export async function resendInvitationAction(invitationId: string): Promise<InvitationActionResult> {
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
  if (membership.role !== "ADMIN") {
    return { success: false, error: "You do not have permission to perform this action." };
  }

  const { data: invitation, error: loadError } = await supabase
    .from("customer_user_invitations")
    .select("id, email, status, last_sent_at")
    .eq("id", invitationId)
    .eq("customer_id", membership.customer.id)
    .maybeSingle();

  if (loadError) {
    return { success: false, error: "Unable to resend this invitation. Please try again." };
  }
  // Either it genuinely doesn't exist, or RLS excluded it because it
  // belongs to another customer — the same response either way, so this
  // never confirms the existence of another tenant's invitation.
  if (!invitation) {
    return { success: false, error: "This invitation could not be found." };
  }
  if (invitation.status !== "PENDING") {
    return { success: false, error: "Only a pending invitation can be resent." };
  }

  const elapsedSeconds = (Date.now() - new Date(invitation.last_sent_at as string).getTime()) / 1000;
  if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
    const retryAfterSeconds = Math.max(1, Math.ceil(RESEND_COOLDOWN_SECONDS - elapsedSeconds));
    return {
      success: false,
      error: `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} before resending.`,
      retryAfterSeconds,
    };
  }

  const now = new Date();
  const nextExpiresAt = new Date(now.getTime() + INVITATION_VALIDITY_MINUTES * 60_000).toISOString();

  // SEND FIRST, MARK SECOND. If delivery fails, last_sent_at and
  // expires_at are left exactly as they were: the invitation is not
  // recorded as sent, no cooldown is started off a send that never
  // happened, and the admin can retry immediately. The reverse order
  // would make a failed send indistinguishable from a successful one in
  // the data.
  const emailResult = await sendInvitationLink({
    invitationId,
    email: invitation.email as string,
  });

  if (!emailResult.sent) {
    return {
      success: false,
      error:
        emailResult.reason === "confirmation_disabled"
          ? "No invitation email was sent: email confirmation is turned off for this project."
          : "The invitation email could not be sent. Please try again.",
    };
  }

  const { data: updated, error: updateError } = await supabase
    .from("customer_user_invitations")
    .update({
      last_sent_at: now.toISOString(),
      expires_at: nextExpiresAt,
    })
    .eq("id", invitationId)
    .eq("customer_id", membership.customer.id)
    // Re-asserting PENDING inside the UPDATE itself closes the gap
    // between the read above and this write: if the invitation were
    // accepted or cancelled in between, this matches zero rows instead
    // of resurrecting it.
    .eq("status", "PENDING")
    .select("id")
    .maybeSingle();

  if (updateError) {
    return { success: false, error: translateDatabaseError(updateError.message) };
  }
  if (!updated) {
    return { success: false, error: "This invitation could not be resent. It may have changed." };
  }

  revalidatePath("/settings/add-user");
  return { success: true };
}

/**
 * Cancels a PENDING invitation. Terminal by design: the row is kept as
 * history (there is no DELETE policy or grant on this table at all), and
 * because the unique index only covers PENDING rows, cancelling frees
 * that email address for a fresh invitation immediately.
 */
export async function cancelInvitationAction(invitationId: string): Promise<InvitationActionResult> {
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
  if (membership.role !== "ADMIN") {
    return { success: false, error: "You do not have permission to perform this action." };
  }

  const { data, error } = await supabase
    .from("customer_user_invitations")
    .update({ status: "CANCELLED" })
    .eq("id", invitationId)
    .eq("customer_id", membership.customer.id)
    // Only from PENDING — an accepted invitation must never be
    // "cancelled" (the membership it produced is managed through
    // customer_users.status instead, see the migration's own note).
    .eq("status", "PENDING")
    .select("id")
    .maybeSingle();

  if (error) {
    return { success: false, error: translateDatabaseError(error.message) };
  }
  if (!data) {
    return { success: false, error: "This invitation could not be cancelled. It may no longer be pending." };
  }

  revalidatePath("/settings/add-user");
  return { success: true };
}

/**
 * Callable directly from a Client Component like an RPC, the same way
 * getCatalogItemsPageAction/getContactsPageAction already are.
 * customer_id is never accepted as a parameter — always derived from the
 * caller's own membership — so a crafted request cannot page through
 * another customer's invitations, and the ADMIN check plus RLS both
 * still apply underneath.
 */
export async function getInvitationsPageAction(params: InvitationsPageParams): Promise<InvitationsPage> {
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
  if (membership.role !== "ADMIN") {
    return { invitations: [], totalCount: 0 };
  }

  return getInvitationsPage(supabase, membership.customer.id, params);
}

/**
 * The invitee's side. A thin wrapper around
 * accept_customer_user_invitation() whose only jobs are to require an
 * authenticated caller and to translate the database's stable messages —
 * every actual decision (does this invitation exist, is it still
 * pending, has it expired, is it addressed to THIS verified email, is
 * the role/manager still valid, does a conflicting membership exist) is
 * re-made inside that function, atomically, and cannot be influenced by
 * anything sent from here beyond the invitation id.
 *
 * Note this deliberately does NOT check membership/role first: the
 * caller is by definition not yet a member of anything.
 */
export async function acceptInvitationAction(invitationId: string): Promise<InvitationActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { error } = await supabase.rpc("accept_customer_user_invitation", {
    p_invitation_id: invitationId,
  });

  // ---------------------------------------------------------------------
  // TEMPORARY DIAGNOSTIC — delete once invitation acceptance is confirmed
  // working end to end.
  //
  // DEVELOPMENT ONLY, so no email address ever reaches a production log.
  // Nothing sensitive is recorded: no tokens, no passwords, no keys, no
  // invitation secret (there isn't one). The probe below runs under the
  // CALLER's own RLS, so it returns a row only for an admin of that
  // customer and nothing at all for an invitee — it grants no access
  // anybody didn't already have, it only reports what they can see.
  //
  // Reading it: the RPC deliberately answers "not found" and "addressed
  // to somebody else" with the SAME message, so the application cannot
  // tell them apart. These two lines can:
  //   invitationVisibleToCaller false + emailsMatch null -> either the id
  //     doesn't exist, or you're signed in as someone who can't see it
  //   emailsMatch false -> the signed-in account is not the invited one
  // ---------------------------------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const normalizedUserEmail = user.email?.trim().toLowerCase() ?? null;

    const { data: probe } = await supabase
      .from("customer_user_invitations")
      .select("id, email, status, expires_at")
      .eq("id", invitationId)
      .maybeSingle();

    const normalizedInvitationEmail =
      typeof probe?.email === "string" ? probe.email.trim().toLowerCase() : null;

    console.log("[invitation:accept]", {
      invitationId,
      authUserId: user.id,
      normalizedUserEmail,
      invitationVisibleToCaller: Boolean(probe),
      normalizedInvitationEmail,
      invitationStatus: probe?.status ?? null,
      invitationExpiresAt: probe?.expires_at ?? null,
      emailsMatch:
        normalizedInvitationEmail === null ? null : normalizedInvitationEmail === normalizedUserEmail,
      rpcError: error?.message ?? null,
    });
  }

  if (error) {
    return { success: false, error: translateDatabaseError(error.message) };
  }

  return { success: true };
}
