import { AuthShell } from "@/features/auth/components/auth-shell";
import { MobileNavDrawer } from "@/components/shared/mobile-nav-drawer";
import { SignUpForm } from "@/features/auth/components/sign-up-form";
import { MessageBanner } from "@/components/shared/message-banner";
import { SiteFooter } from "@/features/marketing/components/site-footer";

type SignUpPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const { error } = await searchParams;

  return (
    <>
      <MobileNavDrawer />
      <AuthShell
        title="Create your account"
        description="Tell us a bit about yourself to get started. We'll send you a link to verify your email."
        step={{ current: 1, total: 2 }}
        hideLogo
      >
        {error === "link_invalid" ? (
          <MessageBanner tone="error">
            This verification link is invalid or has expired. Please sign up again.
          </MessageBanner>
        ) : null}
        <SignUpForm />
      </AuthShell>
      <SiteFooter />
    </>
  );
}
