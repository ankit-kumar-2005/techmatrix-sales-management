import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { MessageBanner } from "@/components/shared/message-banner";
import { approveConsentAction, denyConsentAction } from "@/features/mcp/consent-actions";
import { ConsentCapabilities } from "@/features/mcp/components/consent-capabilities";
import { AUTHORIZATION_ID_PATTERN, loadConsentState } from "@/features/mcp/lib/consent";
import { BRAND_NAME } from "@/lib/brand";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: `Connect an AI app · ${BRAND_NAME}`, robots: { index: false } };

type ConsentPageProps = {
  searchParams: Promise<{ authorization_id?: string; done?: string }>;
};

/**
 * The OAuth consent screen — the path configured as the Authorization
 * Path in Supabase → Authentication → OAuth Server (/oauth/consent).
 * Supabase sends people here with ?authorization_id=… after an AI app
 * (Claude) asks to connect. Signed-out people sign in with their normal
 * account first and come straight back. Never auto-approves; every
 * decision is made in features/mcp/lib/consent.ts and re-made inside the
 * Allow action.
 */
export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const { authorization_id: authorizationId = "", done } = await searchParams;

  if (done === "denied") {
    return (
      <AuthShell title="Request declined" description="Nothing was shared. You can close this window.">
        <p className="text-sm text-neutral-600">If you change your mind, start the connection again from your AI app.</p>
      </AuthShell>
    );
  }

  if (!AUTHORIZATION_ID_PATTERN.test(authorizationId)) {
    return <ExpiredRequest />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${authorizationId}`)}`);
  }

  const state = await loadConsentState(supabase, authorizationId);

  if (state.kind === "already_approved") redirect(state.redirectUrl);
  if (state.kind === "invalid") return <ExpiredRequest />;
  if (state.kind === "refused") {
    return (
      <AuthShell title={state.title}>
        <MessageBanner tone="error">
          <p>{state.message}</p>
        </MessageBanner>
        <p className="mt-5 text-sm text-neutral-600">Nothing was shared. You can close this window.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Connect ${state.clientName} to ${BRAND_NAME}`}
      description={`Review what ${state.clientName} will be able to do before you allow it.`}
      footer={
        <p className="text-xs leading-relaxed text-neutral-500">
          You can disconnect at any time in {BRAND_NAME} under Settings → My AI Connections.
        </p>
      }
    >
      {done === "error" ? (
        <MessageBanner tone="error">
          <p>Something went wrong while connecting. Please try again, or start again from your AI app.</p>
        </MessageBanner>
      ) : null}

      <p className="text-sm leading-relaxed text-neutral-700">
        <span className="font-semibold text-neutral-900">{state.clientName}</span> wants to access {BRAND_NAME} as{" "}
        <span className="font-semibold text-neutral-900">{state.userName}</span> at{" "}
        <span className="font-semibold text-neutral-900">{state.companyName}</span>.
      </p>

      <ConsentCapabilities capabilities={state.capabilities} canChange={state.canChange} />

      <div className="mt-5 rounded-xl bg-gradient-to-r from-blue-50 to-violet-50 p-4 text-sm leading-relaxed text-neutral-700 ring-1 ring-blue-100">
        It only sees and changes what <span className="font-semibold">you</span> can see and change in {BRAND_NAME}.
        Your role and team permissions still apply to everything it does.
      </div>

      <p className="mt-4 text-xs text-neutral-500">
        After you allow, you&apos;ll go back to <span className="font-semibold text-neutral-700">{state.redirectHost}</span>.
      </p>

      {state.isLoopback ? (
        <div className="mt-4">
          <MessageBanner tone="warning">
            <p>
              This connection is for an app running on this computer, such as Claude Code. Only allow it if you started it
              yourself just now.
            </p>
          </MessageBanner>
        </div>
      ) : null}

      <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <form action={denyConsentAction}>
          <input type="hidden" name="authorization_id" value={state.authorizationId} />
          <button
            type="submit"
            className="min-h-11 w-full rounded-full px-5 py-2.5 text-sm font-semibold text-neutral-700 ring-1 ring-neutral-300 transition hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 sm:w-auto"
          >
            Deny
          </button>
        </form>
        <form action={approveConsentAction}>
          <input type="hidden" name="authorization_id" value={state.authorizationId} />
          <button
            type="submit"
            className="min-h-11 w-full rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:from-blue-700 hover:to-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:w-auto"
          >
            Allow
          </button>
        </form>
      </div>
    </AuthShell>
  );
}

function ExpiredRequest() {
  return (
    <AuthShell
      title="This request has expired"
      description="The link is no longer valid. Start the connection again from your AI app."
    >
      <p className="text-sm text-neutral-600">Nothing was shared. You can close this window.</p>
    </AuthShell>
  );
}
