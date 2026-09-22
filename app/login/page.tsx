import { AuthShell } from "@/features/auth/components/auth-shell";
import { MobileNavDrawer } from "@/components/shared/mobile-nav-drawer";
import { LoginForm } from "@/features/auth/components/login-form";
import { MessageBanner } from "@/components/shared/message-banner";
import { SiteFooter } from "@/features/marketing/components/site-footer";
import { BRAND_NAME } from "@/lib/brand";

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
    <>
      <MobileNavDrawer />
      <AuthShell
        title="Welcome back"
        description={`Log in to your ${BRAND_NAME} account.`}
        hideLogo
      >
        {successText ? <MessageBanner tone="success">{successText}</MessageBanner> : null}
        <LoginForm />
      </AuthShell>
      <SiteFooter />
    </>
  );
}
