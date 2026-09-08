/**
 * Translates raw Supabase Auth error messages into safe, user-friendly
 * text. Never forward error.message from Supabase directly to the UI —
 * it can change wording across versions and may describe internal detail
 * users don't need. See CLAUDE.md Section K.
 *
 * "invalid login credentials" is deliberately NOT handled here — it's the
 * one error LoginForm intercepts itself before ever reaching this
 * function, so it can show a different message for "wrong password on a
 * known account" vs. "no account with this email at all" (see
 * login-form.tsx and auth_email_has_account()).
 */
export function mapAuthErrorMessage(message: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes("already registered") || normalized.includes("already exists")) {
    return "This email is already registered. Please log in.";
  }

  if (normalized.includes("email not confirmed")) {
    return "Please verify your email address before logging in.";
  }

  if (normalized.includes("expired") || (normalized.includes("invalid") && normalized.includes("link"))) {
    return "This link is invalid or has expired. Please request a new one.";
  }

  if (normalized.includes("invalid") && normalized.includes("email")) {
    return "Please enter a valid email address.";
  }

  if (normalized.includes("same password") || normalized.includes("should be different")) {
    return "Your new password must be different from your current password.";
  }

  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return "Too many attempts. Please wait a moment and try again.";
  }

  if (normalized.includes("network") || normalized.includes("fetch")) {
    return "Network error. Please check your connection and try again.";
  }

  return "Something went wrong. Please try again.";
}
