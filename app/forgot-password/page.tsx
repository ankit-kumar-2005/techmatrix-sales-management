import { AuthShell } from "@/features/auth/components/auth-shell";
import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form";
import { MessageBanner } from "@/features/auth/components/message-banner";

type ForgotPasswordPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  const { error } = await searchParams;

  return (
    <AuthShell
      title="Reset your password"
      description="Enter the email address for your account and we'll send you a link to reset your password."
    >
      {error === "link_invalid" ? (
        <MessageBanner tone="error">
          This reset link is invalid or has expired. Please request a new one below.
        </MessageBanner>
      ) : null}
      <ForgotPasswordForm />
    </AuthShell>
  );
}
