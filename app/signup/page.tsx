import { AuthShell } from "@/features/auth/components/auth-shell";
import { SignUpForm } from "@/features/auth/components/sign-up-form";
import { MessageBanner } from "@/features/auth/components/message-banner";

type SignUpPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const { error } = await searchParams;

  return (
    <AuthShell
      title="Create your account"
      description="Enter your email to get started. We'll send you a link to verify it."
    >
      {error === "link_invalid" ? (
        <MessageBanner tone="error">
          This verification link is invalid or has expired. Please sign up again.
        </MessageBanner>
      ) : null}
      <SignUpForm />
    </AuthShell>
  );
}
