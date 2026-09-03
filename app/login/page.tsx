import { AuthShell } from "@/features/auth/components/auth-shell";
import { LoginForm } from "@/features/auth/components/login-form";
import { MessageBanner } from "@/features/auth/components/message-banner";

const SUCCESS_MESSAGES: Record<string, string> = {
  password_created: "Your password has been created successfully. Please log in to continue.",
  password_reset: "Your password has been reset successfully. Please log in with your new password.",
};

type LoginPageProps = {
  searchParams: Promise<{ message?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { message } = await searchParams;
  const successText = message ? SUCCESS_MESSAGES[message] : undefined;

  return (
    <AuthShell title="Welcome back" description="Log in to your Techmatrix Sales Management account.">
      {successText ? <MessageBanner tone="success">{successText}</MessageBanner> : null}
      <LoginForm />
    </AuthShell>
  );
}
