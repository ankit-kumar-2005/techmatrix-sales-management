import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { generateTempPassword } from "@/features/auth/lib/generate-temp-password";
import { getAppUrl } from "@/lib/app-url";

/**
 * SERVER-ONLY. Delivers an invitation by asking SUPABASE AUTH to send
 * its own email — the same mechanism signup verification and password
 * recovery already use, which is what Brevo SMTP is wired into at the
 * project level (Supabase → Authentication → Emails → SMTP Settings).
 * This app never talks to an email provider itself: there is no API key,
 * no SMTP socket, no HTML template, and nothing to swap out if the
 * provider changes.
 *
 * WHY signUp() AND NOT admin.inviteUserByEmail():
 * inviteUserByEmail() requires the SERVICE ROLE key — a credential that
 * bypasses RLS entirely, which in a multi-tenant app is the single most
 * dangerous thing that can exist in the runtime. It also fails outright
 * when the address already has an account, so the existing-user case
 * below would still need a second mechanism. signUp() needs no new
 * secret (the publishable key is enough), is the exact call SignUpForm
 * already makes, and gives us Supabase's documented signal for "this
 * address already exists". Nothing here is privileged: authorization was
 * settled by the caller (an ADMIN of this customer) and is re-settled by
 * accept_customer_user_invitation() when the link is used.
 *
 * TWO CASES, TWO SUPABASE AUTH EMAILS, ONE MECHANISM:
 *   NEW address      -> signUp() creates an unconfirmed auth user and
 *                       Supabase sends "Confirm signup". The temp
 *                       password is never shown or reused; the invitee
 *                       sets a real one on the accept page, exactly as
 *                       the existing signup flow does on /set-password.
 *   EXISTING address -> signUp() sends nothing (documented: no error,
 *                       empty identities array), so a magic link goes
 *                       out instead. They already have a password; the
 *                       link only proves they still control the inbox.
 *
 * An auth.users row is NOT an organization membership. A PENDING
 * invitation still creates no customer_users row — that happens only
 * inside accept_customer_user_invitation(), on acceptance.
 */
export type SendInvitationLinkResult =
  | { sent: true }
  | { sent: false; reason: "auth_error" | "confirmation_disabled" };

type SendInvitationLinkParams = {
  invitationId: string;
  /** Already normalized — either by createInvitationSchema or read back
   *  from the invitation row. Never raw form input. */
  email: string;
};

/**
 * A stateless, anonymous Auth client. Deliberately NOT lib/supabase/
 * server.ts: that client is bound to the REQUEST's cookies, which belong
 * to the signed-in ADMIN. Calling signUp() through it could write the
 * invitee's auth cookies over the admin's own session — signing the
 * admin out of their own browser mid-action. persistSession:false means
 * this client has nowhere to write a session at all, which makes that
 * impossible rather than merely unlikely.
 *
 * flowType "implicit" is explicit for a reason: PKCE stores a code
 * verifier on whoever STARTED the flow. Here that is this server
 * process, while the person who finishes it is the invitee in their own
 * browser — they could never present a verifier this client generated,
 * so a PKCE link would be unusable. Implicit puts the session in the
 * redirect URL's fragment instead, which the invitee's own browser
 * consumes on /accept-invitation/continue. Browser-initiated flows
 * (signup, password reset) are untouched and keep using PKCE.
 */
function createStatelessAuthClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: "implicit",
      },
    },
  );
}

export async function sendInvitationLink({
  invitationId,
  email,
}: SendInvitationLinkParams): Promise<SendInvitationLinkResult> {
  const supabase = createStatelessAuthClient();

  // The ONLY identifier in the link is the invitation id, and it is an
  // identifier rather than a secret: it grants nothing on its own. The
  // invitee still has to hold the verified email address, which is what
  // the acceptance RPC actually checks. No customer id, role id,
  // manager id or token ever travels in the URL.
  const emailRedirectTo = `${getAppUrl()}/accept-invitation/continue?invitation_id=${encodeURIComponent(invitationId)}`;

  const { data, error } = await supabase.auth.signUp({
    email,
    password: generateTempPassword(),
    options: {
      // Carried through email verification via user_metadata — the same
      // supported mechanism the existing signup flow uses for
      // name/phone, because the link is usually opened in a different
      // browser than the one that triggered it. The accept page reads
      // this back to decide whether to offer the password step; it is a
      // UI hint only, never an authorization input.
      data: { invitation_id: invitationId },
      emailRedirectTo,
    },
  });

  if (error) {
    // error.code is Supabase's stable signal; the message text varies by
    // project configuration, so it is only a secondary check. Same
    // detection SignUpForm already uses.
    const alreadyExists =
      error.code === "user_already_exists" || /already (registered|exists)/i.test(error.message);

    if (!alreadyExists) {
      // Neither the address nor any Supabase payload is logged — an
      // operational signal, not a data trail.
      console.error(`[invitation] Supabase Auth refused the sign-up (code: ${error.code ?? "unknown"}).`);
      return { sent: false, reason: "auth_error" };
    }
  } else if (data.user?.identities?.length !== 0) {
    // A brand-new (or still-unconfirmed) address: Supabase has sent its
    // confirmation email and there is nothing further to do.
    if (data.session) {
      // A session here can only mean the project has email confirmation
      // switched off, in which case Supabase sent NO email at all. Never
      // report that as sent — the whole invitation depends on the mail.
      return { sent: false, reason: "confirmation_disabled" };
    }
    return { sent: true };
  }

  // Falls through for an address that already has a confirmed account:
  // signUp() deliberately sends nothing in that case.
  const { error: magicLinkError } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Never create a user here — reaching this point means one already
      // exists, and shouldCreateUser:true would quietly turn a failed
      // lookup into a new account.
      shouldCreateUser: false,
      emailRedirectTo,
    },
  });

  if (magicLinkError) {
    console.error(
      `[invitation] Supabase Auth refused the magic link (code: ${magicLinkError.code ?? "unknown"}).`,
    );
    return { sent: false, reason: "auth_error" };
  }

  return { sent: true };
}
