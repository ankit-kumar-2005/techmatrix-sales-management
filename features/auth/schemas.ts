import { z } from "zod";

/**
 * Shared between client-side (immediate feedback) and, implicitly, the
 * server: Supabase Auth itself re-validates email/password server-side, so
 * this schema is the UX layer, not the security boundary. See CLAUDE.md
 * Section J.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required.")
  .email("Please enter a valid email address.");

const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 10 characters and include uppercase, lowercase, number, and special character.";

/**
 * Single source of truth for the password policy, used both by the Zod
 * schema below (blocking validation) and by PasswordRequirements (the
 * live checklist UI) so the two can never drift apart.
 */
export const PASSWORD_RULES: { id: string; label: string; test: (value: string) => boolean }[] = [
  { id: "length", label: "At least 10 characters", test: (value) => value.length >= 10 },
  { id: "uppercase", label: "One uppercase letter", test: (value) => /[A-Z]/.test(value) },
  { id: "lowercase", label: "One lowercase letter", test: (value) => /[a-z]/.test(value) },
  { id: "number", label: "One number", test: (value) => /[0-9]/.test(value) },
  { id: "special", label: "One special character", test: (value) => /[^A-Za-z0-9]/.test(value) },
];

export const passwordSchema = z
  .string()
  .min(1, "Password is required.")
  .superRefine((value, ctx) => {
    if (value.length === 0) return;

    const meetsPolicy = PASSWORD_RULES.every((rule) => rule.test(value));
    if (!meetsPolicy) {
      ctx.addIssue({ code: "custom", message: PASSWORD_POLICY_MESSAGE });
    }
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required."),
});

/**
 * Sign up collects email + phone (required) + company name (optional) —
 * a verification link confirms the address first, and the real password
 * is set afterward (see newPasswordSchema), on /set-password, at which
 * point the customer record is created from phone/companyName (carried
 * through email verification via Supabase's user_metadata, since the
 * verification link is often opened in a different browser/tab).
 */
export const signUpSchema = z.object({
  email: emailSchema,
  phone: z.string().trim().min(1, "Phone is required.").max(30),
  companyName: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

/**
 * Used on both /set-password (first password after signup verification)
 * and /reset-password (forgot-password recovery) — same fields, same
 * policy, same confirm-match rule.
 */
export const newPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string().min(1, "Confirm Password is required."),
  })
  .superRefine((data, ctx) => {
    if (data.password !== data.confirmPassword) {
      ctx.addIssue({
        code: "custom",
        message: "Passwords do not match.",
        path: ["confirmPassword"],
      });
    }
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type NewPasswordInput = z.infer<typeof newPasswordSchema>;
