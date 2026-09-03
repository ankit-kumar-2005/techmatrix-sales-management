/**
 * Generates a cryptographically random, throwaway password to satisfy
 * supabase.auth.signUp()'s required `password` argument for an
 * email-only signup step. It is never shown, logged, or reused —
 * the user sets their real password afterward on /set-password via
 * supabase.auth.updateUser(), which overwrites this value entirely.
 *
 * Using signUp() here (instead of signInWithOtp) is deliberate: it's
 * what lets us detect an already-registered email via Supabase's own
 * documented signal (an empty `identities` array on the response) —
 * see sign-up-form.tsx. signInWithOtp cannot support that check, by
 * design, since it never reveals whether an email already exists.
 *
 * The "Aa1!" suffix guarantees the random value satisfies our own
 * password policy (and any similar policy Supabase's project settings
 * might enforce) regardless of what randomUUID() happens to produce.
 *
 * A single UUID (36 chars) + suffix (4 chars) = 40 chars, kept well
 * under Supabase's hard 72-character password limit (bcrypt's own
 * limit) — two UUIDs previously pushed this to 76 chars, which
 * Supabase rejected with "Password cannot be longer than 72
 * characters", surfacing to the user as a generic error.
 */
export function generateTempPassword(): string {
  return `${crypto.randomUUID()}Aa1!`;
}
