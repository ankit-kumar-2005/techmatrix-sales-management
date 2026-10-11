"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseMcpContext } from "./lib/access";
import { AUTHORIZATION_ID_PATTERN, loadConsentState, registerConnection } from "./lib/consent";
import { checkRedirectUri } from "./lib/redirect-allowlist";

/**
 * The consent screen's two buttons. Each takes ONLY the authorization id
 * from the form and re-derives everything else server-side as the
 * signed-in person (cookie session) — see lib/consent.ts.
 */

function consentPage(authorizationId: string, done?: "denied" | "error"): string {
  const params = new URLSearchParams({ authorization_id: authorizationId });
  if (done) params.set("done", done);
  return `/oauth/consent?${params.toString()}`;
}

function readAuthorizationId(formData: FormData): string {
  const value = formData.get("authorization_id");
  return typeof value === "string" && AUTHORIZATION_ID_PATTERN.test(value) ? value : "";
}

export async function approveConsentAction(formData: FormData): Promise<void> {
  const authorizationId = readAuthorizationId(formData);
  if (!authorizationId) redirect("/oauth/consent");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(consentPage(authorizationId))}`);

  // Every check again, now, against live data.
  const state = await loadConsentState(supabase, authorizationId);
  if (state.kind === "already_approved") redirect(state.redirectUrl);
  if (state.kind !== "ask") redirect(consentPage(authorizationId));

  const { data: rawContext } = await supabase.rpc("get_my_mcp_context", { p_oauth_client_id: state.clientId });
  const context = parseMcpContext(rawContext);
  if (!context) redirect(consentPage(authorizationId));

  const registered = await registerConnection(supabase, context, {
    clientId: state.clientId,
    clientName: state.clientName,
    redirectHost: state.redirectHost,
  });
  if (!registered) redirect(consentPage(authorizationId, "error"));

  const { data, error } = await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
  if (error || !data?.redirect_url || !checkRedirectUri(data.redirect_url).allowed) {
    redirect(consentPage(authorizationId, "error"));
  }

  redirect(data.redirect_url);
}

export async function denyConsentAction(formData: FormData): Promise<void> {
  const authorizationId = readAuthorizationId(formData);
  if (!authorizationId) redirect("/oauth/consent");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(consentPage(authorizationId))}`);

  const { data } = await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });

  // Hand the refusal back to the app only if it is one we recognise;
  // otherwise just tell the person they can close the window.
  if (data?.redirect_url && checkRedirectUri(data.redirect_url).allowed) redirect(data.redirect_url);
  redirect(consentPage(authorizationId, "denied"));
}
