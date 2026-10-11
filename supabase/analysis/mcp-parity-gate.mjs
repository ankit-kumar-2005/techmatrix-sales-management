// =====================================================================
// MCP Phase 0 hard gate — OAuth token parity test.
//
// Proves that an access token issued by the Supabase OAuth 2.1 Server
// carries EXACTLY the signed-in user's existing access — the same rows
// RLS returns to that user's ordinary app session, no more, no fewer —
// and records what the token's claims look like so the MCP endpoint's
// validation rules can be written against facts.
//
// Not application code. Dependency-free (Node >= 22: fetch, WebCrypto,
// process.loadEnvFile). Never prints emails, names, or record content:
// only claims, counts, and record ids in diffs.
//
// Run from the repo root:
//   node supabase/analysis/mcp-parity-gate.mjs
//
// Reads .env.local (Supabase URL + publishable key) and .env.mcp-gate
// (test credentials; git-ignored by the `.env*` rule). The matrix is the
// one agreed for the MCPTEST companies (docs/mcp.md, "Manual tests"):
//   GATE_ADMIN_EMAIL   / GATE_ADMIN_PASSWORD     A Admin
//   GATE_MANAGER_EMAIL / GATE_MANAGER_PASSWORD   A Manager (reports to A Admin)
//   GATE_SENIOR_EMAIL  / GATE_SENIOR_PASSWORD    A Senior Rep (reports to A Manager)
//   GATE_REP_EMAIL     / GATE_REP_PASSWORD       A Rep (reports to A Senior Rep)
//   GATE_PEER_EMAIL    / GATE_PEER_PASSWORD      A Peer Rep (reports to A Admin, outside the Manager's team)
//   GATE_TENANTB_EMAIL / GATE_TENANTB_PASSWORD   B Admin (second company)
//   GATE_CLIENT_ID     (optional) reuse an already-registered OAuth client
//   GATE_RESOURCE      (optional) default https://techmatrix-sales-management.vercel.app/api/mcp
//   GATE_MCP_URL       (optional) the DEPLOYED MCP endpoint. When set, each
//                      person's OAuth token is also sent through
//                      tools/call search_leads and the ids compared with
//                      the app session's, and revocation is checked
//                      against the endpoint. Company A and B must have AI
//                      connections turned ON for this stage.
//
// Side effects, all intentional and listed in the output:
//   * registers one public OAuth client (unless GATE_CLIENT_ID is set)
//   * creates one OAuth grant per test user, all revoked at the end
//   * issues no-op Data API writes per user (values set to what they
//     already are) to prove the OAuth-client restrictions; one probe
//     connection insert per user that must be refused
//     (if a restriction were missing, the probe connection row would remain)
//   * with GATE_MCP_URL: one mcp_connections row per test user (left in
//     place, marked disconnected at the end — disconnects are final, so
//     do not reuse GATE_CLIENT_ID for a later run), audit rows for the
//     calls, a temporary block on the senior rep that is removed again,
//     and a GLOBAL SIGN-OUT of the peer test account (all its sessions end)
// =====================================================================

import { createHash, randomBytes, webcrypto } from "node:crypto";
import { existsSync } from "node:fs";

for (const f of [".env.local", ".env.mcp-gate"]) {
  if (existsSync(f)) process.loadEnvFile(f);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const AUTH = `${SUPABASE_URL}/auth/v1`;
const REST = `${SUPABASE_URL}/rest/v1`;
const RESOURCE =
  process.env.GATE_RESOURCE ?? "https://techmatrix-sales-management.vercel.app/api/mcp";
const REDIRECT_URI = "http://localhost:53682/callback";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const MCP_URL = process.env.GATE_MCP_URL ?? null;

const USERS = ["ADMIN", "MANAGER", "SENIOR", "REP", "PEER", "TENANTB"].map((k) => ({
  key: k.toLowerCase(),
  email: process.env[`GATE_${k}_EMAIL`],
  password: process.env[`GATE_${k}_PASSWORD`],
}));

const missing = [
  ...(!SUPABASE_URL ? ["NEXT_PUBLIC_SUPABASE_URL"] : []),
  ...(!ANON_KEY ? ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] : []),
  ...USERS.flatMap((u) =>
    [!u.email && `GATE_${u.key.toUpperCase()}_EMAIL`, !u.password && `GATE_${u.key.toUpperCase()}_PASSWORD`].filter(Boolean),
  ),
];
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(2);
}

// ---------------------------------------------------------------------
// result bookkeeping
// ---------------------------------------------------------------------

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function info(line) {
  console.log(`        ${line}`);
}
const skipped = [];
function skip(name, reason) {
  skipped.push(`${name} — ${reason}`);
  console.log(`  SKIP  ${name}  — ${reason}`);
}

/** One JSON-RPC tools/call to the deployed MCP endpoint (stateless). */
async function mcpCall(token, name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await json(res);
  return { status: res.status, result: body?.result ?? null };
}

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------

async function json(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

async function passwordSignIn(u) {
  const res = await fetch(`${AUTH}/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: u.email, password: u.password }),
  });
  const body = await json(res);
  if (!res.ok) throw new Error(`[${u.key}] password sign-in failed: HTTP ${res.status} ${body?.error_code ?? body?.error ?? ""}`);
  return body.access_token;
}

async function registerClient() {
  const res = await fetch(`${AUTH}/oauth/clients/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "pipeway-parity-gate (safe to delete)",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const body = await json(res);
  if (res.status !== 201) throw new Error(`client registration failed: HTTP ${res.status}`);
  return body.client_id;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// Full OAuth authorization-code + PKCE flow, approving consent through
// the same Auth API the consent page will call, using the user's own
// app session. The authorize redirect is read, never followed, so no
// consent page is needed.
async function oauthFlow(u, clientId, appToken) {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid email profile offline_access",
    state,
    resource: RESOURCE,
  });
  const authz = await fetch(`${AUTH}/oauth/authorize?${q}`, { redirect: "manual" });
  const location = authz.headers.get("location");
  if (authz.status !== 302 || !location) throw new Error(`[${u.key}] authorize: expected 302, got ${authz.status}`);
  const authorizationId = new URL(location).searchParams.get("authorization_id");
  if (!authorizationId) throw new Error(`[${u.key}] authorize: no authorization_id in redirect`);

  const detailsRes = await fetch(`${AUTH}/oauth/authorizations/${authorizationId}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${appToken}` },
  });
  const details = await json(detailsRes);

  const consentRes = await fetch(`${AUTH}/oauth/authorizations/${authorizationId}/consent`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  const consent = await json(consentRes);
  if (!consentRes.ok || !consent?.redirect_url) throw new Error(`[${u.key}] consent approve failed: HTTP ${consentRes.status}`);
  const cb = new URL(consent.redirect_url);
  if (cb.searchParams.get("state") !== state) throw new Error(`[${u.key}] state mismatch on callback`);
  const code = cb.searchParams.get("code");
  if (!code) throw new Error(`[${u.key}] no code on callback (error=${cb.searchParams.get("error")})`);

  const tokenRes = await fetch(`${AUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  const tokens = await json(tokenRes);
  if (!tokenRes.ok) throw new Error(`[${u.key}] token exchange failed: HTTP ${tokenRes.status} ${tokens?.error ?? ""}`);
  return { details, tokens, codeReplay: { code, verifier } };
}

// ---------------------------------------------------------------------
// JWT verification against the project's JWKS
// ---------------------------------------------------------------------

let jwksCache;
async function verifyJwt(token) {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const payload = JSON.parse(Buffer.from(p, "base64url"));
  jwksCache ??= (await (await fetch(`${AUTH}/.well-known/jwks.json`)).json()).keys;
  const jwk = jwksCache.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "ES256") return { valid: false, header, payload, reason: `no ES256 key for kid ${header.kid} (alg ${header.alg})` };
  const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(s, "base64url"),
    Buffer.from(`${h}.${p}`),
  );
  return { valid, header, payload };
}

// Safe claim summary: no email, phone, name, or user_metadata values.
function claimSummary(payload) {
  const out = {};
  for (const k of ["iss", "aud", "role", "client_id", "aal", "is_anonymous", "sub", "scope"]) {
    if (k in payload) out[k] = payload[k];
  }
  out.lifetime_s = payload.exp - payload.iat;
  out.has_session_id = "session_id" in payload;
  out.amr = Array.isArray(payload.amr) ? payload.amr.map((a) => a.method ?? a) : payload.amr;
  out.claim_keys = Object.keys(payload).sort().join(",");
  return out;
}

// ---------------------------------------------------------------------
// data access with a given bearer token (PostgREST, anon key + JWT)
// ---------------------------------------------------------------------

function restHeaders(token, extra = {}) {
  return { apikey: ANON_KEY, Authorization: `Bearer ${token}`, ...extra };
}

async function allIds(table, token) {
  const ids = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${REST}/${table}?select=id&order=id`, {
      headers: restHeaders(token, { Range: `${from}-${from + page - 1}`, "Range-Unit": "items" }),
    });
    if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
    const rows = await res.json();
    ids.push(...rows.map((r) => r.id));
    if (rows.length < page) break;
  }
  return new Set(ids);
}

async function rpc(fn, token) {
  const res = await fetch(`${REST}/rpc/${fn}`, {
    method: "POST",
    headers: restHeaders(token, { "Content-Type": "application/json" }),
    body: "{}",
  });
  return { status: res.status, body: await json(res) };
}

async function countByIds(table, ids, token) {
  let n = 0;
  const list = [...ids];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const res = await fetch(`${REST}/${table}?select=id&id=in.(${chunk.join(",")})`, {
      headers: restHeaders(token, { Prefer: "count=exact" }),
    });
    if (!res.ok) throw new Error(`${table} cross-tenant probe failed: HTTP ${res.status}`);
    n += (await res.json()).length;
  }
  return n;
}

function diff(a, b) {
  return [...a].filter((x) => !b.has(x));
}
function intersect(a, b) {
  return [...a].filter((x) => b.has(x));
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

const TABLES = ["leads", "tasks", "contacts"];
const RPCS = ["get_forecast_summary", "get_forecast_by_stage"];

async function main() {
  console.log(`MCP parity gate — ${new Date().toISOString()}`);
  console.log(`Project: ${SUPABASE_URL}`);
  console.log(`Resource requested: ${RESOURCE}\n`);

  const clientId = process.env.GATE_CLIENT_ID ?? (await registerClient());
  console.log(`OAuth client: ${clientId}${process.env.GATE_CLIENT_ID ? " (reused)" : " (registered for this run — delete under Authentication → OAuth Apps)"}\n`);

  const state = {};

  for (const u of USERS) {
    console.log(`── ${u.key.toUpperCase()} ─────────────────────────────────────────`);
    const appToken = await passwordSignIn(u);
    const { details, tokens, codeReplay } = await oauthFlow(u, clientId, appToken);
    const oauthToken = tokens.access_token;

    info(`consent details: client_name=${JSON.stringify(details?.client?.client_name ?? details?.client_name ?? null)} redirect=${JSON.stringify(details?.redirect_uri ?? null)} scope=${JSON.stringify(details?.scope ?? null)}`);
    info(`token response: token_type=${tokens.token_type} expires_in=${tokens.expires_in} refresh_token=${tokens.refresh_token ? "present" : "absent"} scope=${JSON.stringify(tokens.scope ?? null)}`);

    // --- claims -------------------------------------------------------
    const appJwt = await verifyJwt(appToken);
    const oauthJwt = await verifyJwt(oauthToken);
    info(`app   token claims: ${JSON.stringify(claimSummary(appJwt.payload))}`);
    info(`oauth token claims: ${JSON.stringify(claimSummary(oauthJwt.payload))}`);
    check(`${u.key}: OAuth token signature verifies against JWKS (ES256)`, oauthJwt.valid, oauthJwt.reason ?? "");
    check(`${u.key}: issuer is the project's auth issuer`, oauthJwt.payload.iss === AUTH, oauthJwt.payload.iss);
    check(`${u.key}: OAuth token is unexpired`, oauthJwt.payload.exp * 1000 > Date.now());
    check(`${u.key}: same subject as the app session`, oauthJwt.payload.sub === appJwt.payload.sub);
    check(`${u.key}: role claim is 'authenticated'`, oauthJwt.payload.role === "authenticated", String(oauthJwt.payload.role));
    check(`${u.key}: OAuth token carries client_id = registered client`, oauthJwt.payload.client_id === clientId, String(oauthJwt.payload.client_id));
    check(`${u.key}: app session token has NO client_id (discriminator works)`, !("client_id" in appJwt.payload));
    check(
      `${u.key}: OAuth token carries a session_id (required: MCP refuses tokens it cannot tie to a live sign-in)`,
      typeof oauthJwt.payload.session_id === "string",
    );
    const aud = [].concat(oauthJwt.payload.aud ?? []);
    info(`aud contains requested resource: ${aud.includes(RESOURCE)}  (informational — decides audience validation)`);

    // --- authorization code is single-use ---------------------------
    const replay = await fetch(`${AUTH}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: codeReplay.code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: codeReplay.verifier }),
    });
    check(`${u.key}: authorization code cannot be replayed`, replay.status >= 400, `HTTP ${replay.status}`);

    // --- row parity ---------------------------------------------------
    const ids = {};
    for (const t of TABLES) {
      const viaApp = await allIds(t, appToken);
      const viaOauth = await allIds(t, oauthToken);
      const extra = diff(viaOauth, viaApp);
      const lacking = diff(viaApp, viaOauth);
      check(
        `${u.key}: ${t} — OAuth token sees exactly the app session's rows`,
        extra.length === 0 && lacking.length === 0,
        `app=${viaApp.size} oauth=${viaOauth.size} extra=${extra.length} missing=${lacking.length}${extra.length ? ` e.g. ${extra.slice(0, 3)}` : ""}`,
      );
      ids[t] = viaApp;
    }
    for (const fn of RPCS) {
      const a = await rpc(fn, appToken);
      const o = await rpc(fn, oauthToken);
      check(`${u.key}: ${fn} identical for both tokens`, a.status === 200 && JSON.stringify(a.body) === JSON.stringify(o.body), `HTTP app=${a.status} oauth=${o.status}`);
    }

    // --- direct Data API restrictions (20261011120000) ----------------
    // Non-destructive probes: every write below sets a value to what it
    // already is, so even if a restriction were missing nothing would
    // change. Blocked = PostgREST returns no rows (UPDATE filtered) or an
    // error (INSERT refused).
    const myCtx = await json(
      await fetch(`${REST}/rpc/get_my_mcp_context`, {
        method: "POST",
        headers: restHeaders(appToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ p_oauth_client_id: null }),
      }),
    );
    if (myCtx?.customer_user_id) {
      const writesAllowed = myCtx.mcp_enabled === true && myCtx.allow_writes === true;
      const ownLeads = await json(
        await fetch(`${REST}/leads?select=id,next_step&owner_id=eq.${myCtx.customer_user_id}&closed_at=is.null&limit=1`, {
          headers: restHeaders(appToken),
        }),
      );
      if (Array.isArray(ownLeads) && ownLeads[0]) {
        const lead = ownLeads[0];
        const noop = await fetch(`${REST}/leads?id=eq.${lead.id}`, {
          method: "PATCH",
          headers: restHeaders(oauthToken, { "Content-Type": "application/json", Prefer: "return=representation" }),
          body: JSON.stringify({ next_step: lead.next_step }),
        });
        const rows = await json(noop);
        const changed = Array.isArray(rows) ? rows.length : -1;
        check(
          writesAllowed
            ? `${u.key}: direct Data API lead write with the OAuth token is permitted ('Allow changes' is on)`
            : `${u.key}: direct Data API lead write with the OAuth token is blocked ('Allow changes' is off)`,
          writesAllowed ? changed === 1 : changed === 0,
          `HTTP ${noop.status}, rows=${changed}`,
        );
      } else {
        skip(`${u.key}: direct Data API lead write`, "this person owns no open lead to probe with");
      }

      const connectionInsert = await fetch(`${REST}/mcp_connections`, {
        method: "POST",
        headers: restHeaders(oauthToken, { "Content-Type": "application/json", Prefer: "return=minimal" }),
        body: JSON.stringify({
          customer_id: myCtx.customer_id,
          customer_user_id: myCtx.customer_user_id,
          oauth_client_id: `parity-probe-${randomBytes(4).toString("hex")}`,
          client_name: "parity probe",
          redirect_domain: "localhost",
        }),
      });
      check(`${u.key}: the OAuth token cannot register AI connections directly`, !connectionInsert.ok, `HTTP ${connectionInsert.status}`);

      if (myCtx.role === "ADMIN") {
        const viaApp = await json(await fetch(`${REST}/customer_integrations?select=id`, { headers: restHeaders(appToken) }));
        const viaOAuth = await json(await fetch(`${REST}/customer_integrations?select=id`, { headers: restHeaders(oauthToken) }));
        info(`integrations visible: app session ${Array.isArray(viaApp) ? viaApp.length : "?"}, OAuth token ${Array.isArray(viaOAuth) ? viaOAuth.length : "?"}`);
        check(`${u.key}: the OAuth token cannot read integrations (webhook credentials)`, Array.isArray(viaOAuth) && viaOAuth.length === 0);

        const settingsNoop = await fetch(`${REST}/customer_mcp_settings?customer_id=eq.${myCtx.customer_id}`, {
          method: "PATCH",
          headers: restHeaders(oauthToken, { "Content-Type": "application/json", Prefer: "return=representation" }),
          body: JSON.stringify({ allow_writes: myCtx.allow_writes }),
        });
        const settingsRows = await json(settingsNoop);
        check(
          `${u.key}: the OAuth token cannot change MCP settings ("Allow changes")`,
          Array.isArray(settingsRows) && settingsRows.length === 0,
          `HTTP ${settingsNoop.status}, rows=${Array.isArray(settingsRows) ? settingsRows.length : "?"}`,
        );
      }
    } else {
      skip(`${u.key}: direct Data API restrictions`, "no active membership context");
    }

    // --- the deployed MCP endpoint, end to end (optional) ------------
    let mcp = null;
    if (MCP_URL) {
      const ctxRes = await fetch(`${REST}/rpc/get_my_mcp_context`, {
        method: "POST",
        headers: restHeaders(appToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ p_oauth_client_id: clientId }),
      });
      const ctx = await json(ctxRes);
      if (!ctx?.mcp_enabled) {
        skip(`${u.key}: MCP endpoint stage`, "AI connections are OFF for this company — turn them on in Settings → AI Connections");
      } else {
        // Register the connection exactly as the consent page does: the
        // person's own row, under RLS, as the person.
        await fetch(`${REST}/mcp_connections?on_conflict=customer_user_id,oauth_client_id`, {
          method: "POST",
          headers: restHeaders(appToken, { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates" }),
          body: JSON.stringify({
            customer_id: ctx.customer_id,
            customer_user_id: ctx.customer_user_id,
            oauth_client_id: clientId,
            client_name: "pipeway-parity-gate",
            redirect_domain: "localhost",
          }),
        });
        // A disconnect is final for an OAuth client (revoked_at is one-way),
        // so a GATE_CLIENT_ID disconnected in an earlier run cannot be revived.
        const recheck = await json(
          await fetch(`${REST}/rpc/get_my_mcp_context`, {
            method: "POST",
            headers: restHeaders(appToken, { "Content-Type": "application/json" }),
            body: JSON.stringify({ p_oauth_client_id: clientId }),
          }),
        );
        if (recheck?.person_blocked) {
          skip(`${u.key}: MCP endpoint stage`, "this person is blocked in Settings → AI Connections — unblock them first");
        } else if (!recheck?.connection || recheck.connection.revoked) {
          skip(`${u.key}: MCP endpoint stage`, "connection missing or disconnected in an earlier run — unset GATE_CLIENT_ID so a fresh client is registered");
        } else {
        mcp = { customerUserId: ctx.customer_user_id, customerId: ctx.customer_id };

        // Identity arguments must have zero effect.
        const call = await mcpCall(oauthToken, "search_leads", { limit: 50, customer_id: NIL_UUID, owner_id: NIL_UUID, role: "ADMIN" });
        const viaMcp = new Set((call.result?.structuredContent?.leads ?? []).map((lead) => lead.id));
        if (call.result?.isError) {
          check(`${u.key}: MCP search_leads succeeds`, false, `error=${call.result?.structuredContent?.error?.code}`);
        } else if (ids.leads.size > 50) {
          skip(`${u.key}: MCP search_leads parity`, `app sees ${ids.leads.size} leads; tool returns at most 50`);
        } else {
          const extra = diff(viaMcp, ids.leads);
          const lacking = diff(ids.leads, viaMcp);
          check(
            `${u.key}: MCP search_leads returns exactly the app session's leads (identity args ignored)`,
            extra.length === 0 && lacking.length === 0,
            `app=${ids.leads.size} mcp=${viaMcp.size} extra=${extra.length} missing=${lacking.length}`,
          );
        }
        const sessionCall = await mcpCall(appToken, "search_leads", {});
        check(`${u.key}: MCP endpoint refuses an ordinary app session token`, sessionCall.status === 401, `HTTP ${sessionCall.status}`);
        }
      }
    }

    state[u.key] = { appToken, oauthToken, tokens, ids, mcp };
    console.log("");
  }

  // --- hierarchy and tenancy cross-checks ----------------------------
  // Matrix: Rep -> Senior Rep -> Manager -> Admin; Peer -> Admin.
  console.log("── CROSS-CHECKS ───────────────────────────────────────────");
  const { admin, manager, senior, rep, peer, tenantb } = state;
  const contained = (inner, outer, label) => {
    const missing = diff(inner.ids.leads, outer.ids.leads);
    check(label, missing.length === 0, `missing=${missing.length}`);
  };
  contained(rep, senior, "senior rep sees every lead the rep (their report) sees");
  contained(senior, manager, "manager sees every lead the senior rep (their report) sees");
  contained(manager, admin, "admin sees every lead the manager sees");
  contained(peer, admin, "admin sees every lead the peer sees");
  for (const who of ["manager", "senior", "rep"]) {
    const overlap = intersect(peer.ids.leads, state[who].ids.leads);
    check(`${who} sees none of the peer's leads (peer is outside their team)`, overlap.length === 0, `overlap=${overlap.length}`);
  }
  check("rep never sees more leads than the manager", rep.ids.leads.size <= manager.ids.leads.size, `rep=${rep.ids.leads.size} manager=${manager.ids.leads.size}`);

  const tenantA = ["admin", "manager", "senior", "rep", "peer"];
  for (const t of TABLES) {
    const bIds = tenantb.ids[t];
    const aIds = new Set(tenantA.flatMap((who) => [...state[who].ids[t]]));
    for (const who of tenantA) {
      const n = bIds.size ? await countByIds(t, bIds, state[who].oauthToken) : 0;
      check(`${who} OAuth token cannot read tenant B ${t} by id`, n === 0, `probed=${bIds.size} returned=${n}`);
    }
    const n = aIds.size ? await countByIds(t, aIds, tenantb.oauthToken) : 0;
    check(`tenant B OAuth token cannot read tenant A ${t} by id`, n === 0, `probed=${aIds.size} returned=${n}`);
  }
  if (tenantb.ids.leads.size === 0) info("WARNING: tenant B has no leads — cross-tenant lead probe is vacuous. Add a test lead.");
  if (peer.ids.leads.size === 0) info("WARNING: peer has no leads — 'no peer leads' check is vacuous. Add a test lead.");

  // --- refresh rotation and revocation (rep) -------------------------
  console.log("\n── REFRESH + REVOCATION (rep) ──────────────────────────────");
  const r1 = rep.tokens.refresh_token;
  const refresh = async (rt) => {
    const res = await fetch(`${AUTH}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }),
    });
    return { status: res.status, body: await json(res) };
  };
  const ref1 = await refresh(r1);
  check("refresh grant works", ref1.status === 200, `HTTP ${ref1.status}`);
  const r2 = ref1.body?.refresh_token;
  check("refresh token rotates (new token returned)", !!r2 && r2 !== r1);
  const refreshedJwt = ref1.body?.access_token ? await verifyJwt(ref1.body.access_token) : null;
  check("refreshed access token keeps client_id", refreshedJwt?.payload?.client_id === clientId);

  const grantsRes = await fetch(`${AUTH}/user/oauth/grants`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${rep.appToken}` } });
  const grants = await json(grantsRes);
  const grantList = Array.isArray(grants) ? grants : grants?.grants ?? [];
  info(`listGrants: HTTP ${grantsRes.status}, ${grantList.length} grant(s); keys of first: ${grantList[0] ? Object.keys(grantList[0]).join(",") : "n/a"}`);
  check("listGrants shows the gate client", JSON.stringify(grantList).includes(clientId));

  const revokeRes = await fetch(`${AUTH}/user/oauth/grants?client_id=${clientId}`, {
    method: "DELETE",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${rep.appToken}` },
  });
  check("revokeGrant succeeds", revokeRes.ok, `HTTP ${revokeRes.status}`);
  const ref2 = await refresh(r2);
  check("refresh after revoke is refused (invalid_grant)", ref2.status >= 400, `HTTP ${ref2.status} ${ref2.body?.error ?? ""}`);
  const after = await fetch(`${REST}/leads?select=id&limit=1`, { headers: restHeaders(ref1.body.access_token) });
  info(`already-issued access token after revoke: REST HTTP ${after.status} — ${after.ok ? "STILL ACCEPTED by Supabase REST until exp (known limitation)" : "rejected immediately"}`);

  // --- immediate disconnect + admin block at the MCP endpoint ---------
  if (MCP_URL && rep.mcp && admin.mcp && senior.mcp) {
    console.log("\n── MCP DISCONNECT + BLOCK ───────────────────────────────────");
    // The rep disconnects (what Settings → My AI Connections does first):
    // their still-unexpired access token must be refused on the next call.
    const repConnection = `${REST}/mcp_connections?customer_user_id=eq.${rep.mcp.customerUserId}&oauth_client_id=eq.${clientId}`;
    await fetch(`${repConnection}&revoked_at=is.null`, {
      method: "PATCH",
      headers: restHeaders(rep.appToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });
    const afterDisconnect = await mcpCall(ref1.body.access_token, "search_leads", {});
    check(
      "disconnected connection is refused by MCP on the very next call (token not yet expired)",
      afterDisconnect.result?.structuredContent?.error?.code === "access_denied",
      `got ${afterDisconnect.result?.structuredContent?.error?.code ?? `HTTP ${afterDisconnect.status}`}`,
    );

    // M3: neither the person nor a holder of their token can undo it.
    const undo = await fetch(repConnection, {
      method: "PATCH",
      headers: restHeaders(ref1.body.access_token, { "Content-Type": "application/json" }),
      body: JSON.stringify({ revoked_at: null }),
    });
    const stillRefused = await mcpCall(ref1.body.access_token, "search_leads", {});
    check(
      "a disconnect cannot be undone through the REST API with the same token",
      !undo.ok && stillRefused.result?.structuredContent?.error?.code === "access_denied",
      `undo HTTP ${undo.status}, next call ${stillRefused.result?.structuredContent?.error?.code ?? `HTTP ${stillRefused.status}`}`,
    );

    // The admin blocks the senior rep (person-level): refused immediately;
    // unblocked: works again.
    const setBlock = (blocked) =>
      blocked
        ? fetch(`${REST}/mcp_user_blocks`, {
            method: "POST",
            headers: restHeaders(admin.appToken, { "Content-Type": "application/json", Prefer: "return=minimal" }),
            body: JSON.stringify({ customer_id: admin.mcp.customerId, customer_user_id: senior.mcp.customerUserId }),
          })
        : fetch(`${REST}/mcp_user_blocks?customer_user_id=eq.${senior.mcp.customerUserId}`, {
            method: "DELETE",
            headers: restHeaders(admin.appToken),
          });
    await setBlock(true);
    const whileBlocked = await mcpCall(senior.oauthToken, "search_leads", {});
    check(
      "admin block is enforced on the person's very next MCP call",
      whileBlocked.result?.structuredContent?.error?.code === "access_denied",
      `got ${whileBlocked.result?.structuredContent?.error?.code ?? `HTTP ${whileBlocked.status}`}`,
    );
    await setBlock(false);
    const afterUnblock = await mcpCall(senior.oauthToken, "search_leads", {});
    check("unblocking restores access", afterUnblock.result && !afterUnblock.result.isError, `HTTP ${afterUnblock.status}`);
  }

  // --- R3: a global sign-out ends the OAuth token at the endpoint -----
  // Signs the PEER test account out everywhere (Supabase deletes all of
  // its sessions). Their still-unexpired OAuth access token must then be
  // refused by MCP with 401 on the very next call.
  if (MCP_URL && peer.mcp) {
    console.log("\n── SIGN-OUT (peer) ──────────────────────────────────────────");
    const before = await mcpCall(peer.oauthToken, "search_leads", { limit: 1 });
    check("peer's OAuth token works before sign-out", before.status === 200 && !before.result?.isError, `HTTP ${before.status}`);
    const logout = await fetch(`${AUTH}/logout?scope=global`, {
      method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${peer.appToken}` },
    });
    info(`global sign-out: HTTP ${logout.status}`);
    const afterLogout = await mcpCall(peer.oauthToken, "search_leads", { limit: 1 });
    check(
      "after a global sign-out, MCP refuses the still-unexpired OAuth token (401)",
      afterLogout.status === 401,
      `HTTP ${afterLogout.status}${afterLogout.result?.structuredContent?.error ? ` ${afterLogout.result.structuredContent.error.code}` : ""}`,
    );
    // The sign-out also ended the peer's app session; sign in again so the
    // cleanup below can still revoke their grant and mark the connection.
    peer.appToken = await passwordSignIn(USERS.find((x) => x.key === "peer"));
  }

  // --- cleanup: revoke remaining grants ------------------------------
  for (const who of ["admin", "manager", "senior", "peer", "tenantb"]) {
    await fetch(`${AUTH}/user/oauth/grants?client_id=${clientId}`, {
      method: "DELETE",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${state[who].appToken}` },
    });
    if (state[who].mcp) {
      await fetch(`${REST}/mcp_connections?customer_user_id=eq.${state[who].mcp.customerUserId}&oauth_client_id=eq.${clientId}&revoked_at=is.null`, {
        method: "PATCH",
        headers: restHeaders(state[who].appToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      });
    }
  }
  info("cleanup: grants revoked and gate connections marked disconnected for every test user");

  const failed = results.filter((r) => !r.pass);
  if (skipped.length) {
    console.log(`\nSKIPPED (${skipped.length}):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nABORTED: ${e.message}`);
  process.exit(1);
});
