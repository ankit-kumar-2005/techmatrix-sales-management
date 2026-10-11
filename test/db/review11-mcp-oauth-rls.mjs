import { asUser, client, seed } from "./seed.mjs";

/**
 * 20261011120000_mcp_oauth_client_restrictions.sql under real RLS.
 *
 * Each case runs the SAME statement as the SAME person through two kinds
 * of request:
 *   app session   — JWT claims without client_id (password/magic-link
 *                   sign-in): must behave exactly as before;
 *   OAuth client  — JWT claims WITH client_id, set the way PostgREST sets
 *                   them (request.jwt.claims) for a token issued by
 *                   Supabase's OAuth server to an AI client.
 *
 * What this cannot prove locally: that real Supabase OAuth tokens carry
 * client_id (Supabase documents that they do) and that PostgREST exposes
 * it via auth.jwt() — both are checked by the live parity gate.
 */

let pass = 0;
let fail = 0;
function check(ok, message) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${message}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${message}`);
  }
}
const head = (m) => console.log(`\n=== ${m} ===`);
const openConnections = [];

/** A statement in its own savepoint: { ok, rows, rowCount, error }. */
async function attempt(conn, sql, params = []) {
  await conn.query("savepoint s");
  try {
    const r = await conn.query(sql, params);
    await conn.query("release savepoint s");
    return { ok: true, rows: r.rows, rowCount: r.rowCount };
  } catch (error) {
    await conn.query("rollback to savepoint s");
    return { ok: false, rows: [], rowCount: 0, error: error.message };
  }
}

/** A connection whose JWT carries client_id, like an OAuth-issued token. */
async function asOAuthClient(userId, clientId = "oauth-client-1") {
  const c = client();
  await c.connect();
  const claims = { sub: userId, role: "authenticated", client_id: clientId, session_id: "00000000-0000-4000-8000-000000000001" };
  await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await c.query(`set role authenticated`);
  openConnections.push(c);
  return c;
}

async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();
  openConnections.push(db);

  // ---- Fixtures (as the table owner, committed) -----------------------
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  await db.query(`insert into public.customer_mcp_settings (customer_id, enabled, allow_writes) values ($1, true, false)`, [ids.custA]);
  const integration = (await one(`insert into public.customer_integrations (customer_id, source) values ($1, 'FixtureSource') returning id`, [ids.custA])).id;
  await db.query(
    `insert into public.customer_integration_participants (customer_id, integration_id, customer_user_id) values ($1, $2, $3)`,
    [ids.custA, integration, ids.repA],
  );
  const automation = (await one(`insert into public.customer_automations (customer_id, name) values ($1, 'Fixture automation') returning id`, [ids.custA])).id;
  const salesRepRole = (await one(`select id from public.roles where name = 'SALES_REP'`)).id;
  const invitation = (await one(
    `insert into public.customer_user_invitations (customer_id, email, full_name, role_id, invited_by) values ($1, 'fixture.invite@example.test', 'Fixture Invite', $2, $3) returning id`,
    [ids.custA, salesRepRole, ids.adminA_auth],
  )).id;
  const catalogItem = (await one(
    `insert into public.customer_catalog_items (customer_id, name, category, price, pricing_unit) values ($1, 'Fixture item', 'Fixture', 10, 'Monthly') returning id`,
    [ids.custA],
  )).id;
  const note = (await one(
    `insert into public.meeting_notes (customer_id, owner_id, title, summary, source_kind, raw_source, model_used) values ($1, $2, 'Fixture note', 'Summary', 'Text', 'Raw', 'fixture-model') returning id`,
    [ids.custA, ids.adminA],
  )).id;
  const actionItem = (await one(
    `insert into public.meeting_note_action_items (customer_id, meeting_note_id, display_order, subject) values ($1, $2, 1, 'Fixture action') returning id`,
    [ids.custA, note],
  )).id;
  const contactA = (await one(`insert into public.contacts (customer_id, lead_id, owner_id, name) values ($1, $2, $3, 'Fixture contact one') returning id`, [ids.custA, ids.leadA, ids.repA])).id;
  const contactB = (await one(`insert into public.contacts (customer_id, lead_id, owner_id, name) values ($1, $2, $3, 'Fixture contact two') returning id`, [ids.custA, ids.leadA, ids.repA])).id;
  const [pairA, pairB] = [contactA, contactB].sort();
  const task = (await one(`insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to) values ($1, $2, 'Fixture task', current_date, $3) returning id`, [ids.custA, ids.leadA, ids.repA])).id;
  const connection = (await one(
    `insert into public.mcp_connections (customer_id, customer_user_id, oauth_client_id, client_name, redirect_domain) values ($1, $2, 'oauth-client-1', 'Claude', 'claude.ai') returning id`,
    [ids.custA, ids.repA],
  )).id;

  const appAdmin = await asUser(ids.adminA_auth);
  const oauthAdmin = await asOAuthClient(ids.adminA_auth);
  const appRep = await asUser(ids.repA_auth);
  const oauthRep = await asOAuthClient(ids.repA_auth);
  const oauthRepB = await asOAuthClient(ids.repB_auth);
  const oauthAdminB = await asOAuthClient(ids.adminB_auth);
  openConnections.push(appAdmin, appRep);
  for (const c of [appAdmin, oauthAdmin, appRep, oauthRep, oauthRepB, oauthAdminB]) await c.query("begin");

  // ===================================================================
  head("claim detection");
  // ===================================================================
  check((await oauthAdmin.query(`select public.mcp_request_is_oauth_client() v`)).rows[0].v === true, "a token with client_id is recognised as an OAuth client");
  check((await appAdmin.query(`select public.mcp_request_is_oauth_client() v`)).rows[0].v === false, "an ordinary app session is not");

  // ===================================================================
  head("administrative configuration: app session keeps access, OAuth client is blocked");
  // ===================================================================

  /**
   * Runs the statement as the OAuth client first, then as the app session.
   * kind: "insert" → OAuth must error, app must succeed;
   *       "update"/"delete" → OAuth must affect 0 rows, app ≥ 1;
   *       "select" → OAuth sees 0 rows, app ≥ 1.
   */
  async function pair(label, kind, sql, params = []) {
    const viaOAuth = await attempt(oauthAdmin, sql, params);
    const viaApp = await attempt(appAdmin, sql, params);
    const blocked = kind === "insert" ? !viaOAuth.ok : viaOAuth.ok && viaOAuth.rowCount === 0;
    const allowed = kind === "insert" ? viaApp.ok : viaApp.ok && viaApp.rowCount >= 1;
    check(blocked, `OAuth client blocked: ${label}${blocked ? "" : ` (got ${viaOAuth.ok ? `${viaOAuth.rowCount} rows` : viaOAuth.error})`}`);
    check(allowed, `app session unchanged: ${label}${allowed ? "" : ` (got ${viaApp.ok ? `${viaApp.rowCount} rows` : viaApp.error})`}`);
  }

  await pair("MCP settings — turn on Allow changes", "update", `update public.customer_mcp_settings set allow_writes = allow_writes where customer_id = $1`, [ids.custA]);
  await pair("MCP tool switch — enable a write tool", "insert", `insert into public.customer_mcp_tools (customer_id, tool_name, enabled) values ($1, 'create_lead', true)`, [ids.custA]);
  await pair("MCP blocks — block a person", "insert", `insert into public.mcp_user_blocks (customer_id, customer_user_id) values ($1, $2)`, [ids.custA, ids.seniorA]);
  await pair("MCP blocks — unblock a person", "delete", `delete from public.mcp_user_blocks where customer_user_id = $1`, [ids.seniorA]);
  await pair("integrations — read webhook credentials", "select", `select webhook_token from public.customer_integrations where id = $1`, [integration]);
  await pair("integrations — create", "insert", `insert into public.customer_integrations (customer_id, source) values ($1, 'AnotherSource')`, [ids.custA]);
  await pair("integrations — change (e.g. rotate token)", "update", `update public.customer_integrations set status = status where id = $1`, [integration]);
  await pair("integration participants — add", "insert", `insert into public.customer_integration_participants (customer_id, integration_id, customer_user_id) values ($1, $2, $3)`, [ids.custA, integration, ids.seniorA]);
  await pair("integration participants — remove", "delete", `delete from public.customer_integration_participants where integration_id = $1 and customer_user_id = $2`, [integration, ids.repA]);
  // created_by = auth.uid() is required by the existing permissive policy; with it
  // satisfied, the app succeeds — so an OAuth refusal is the restrictive policy's.
  await pair("automations — create", "insert", `insert into public.customer_automations (customer_id, name, created_by) values ($1, 'Injected automation', $2)`, [ids.custA, ids.adminA_auth]);
  await pair("automations — change", "update", `update public.customer_automations set name = name where id = $1`, [automation]);
  await pair(
    "automation versions — create",
    "insert",
    `insert into public.customer_automation_versions (customer_id, automation_id, version, trigger_type, definition, created_by) values ($1, $2, 1, 'lead.created', '{}'::jsonb, $3)`,
    [ids.custA, automation, ids.adminA_auth],
  );
  await pair(
    "invitations — create",
    "insert",
    `insert into public.customer_user_invitations (customer_id, email, full_name, role_id, invited_by) values ($1, 'injected@example.test', 'Injected', $2, $3)`,
    [ids.custA, salesRepRole, ids.adminA_auth],
  );
  await pair("invitations — change", "update", `update public.customer_user_invitations set full_name = full_name where id = $1`, [invitation]);
  await pair("company details — change", "update", `update public.customers set phone = phone where id = $1`, [ids.custA]);
  await pair("lead stages — create", "insert", `insert into public.customer_lead_stages (customer_id, stage, display_order) values ($1, 'Injected stage', 99)`, [ids.custA]);
  await pair("lead stages — change", "update", `update public.customer_lead_stages set stage = stage where id = $1`, [ids.stageA]);
  await pair(
    "catalog items — create",
    "insert",
    `insert into public.customer_catalog_items (customer_id, name, category, price, pricing_unit) values ($1, 'Injected', 'X', 1, 'One-time')`,
    [ids.custA],
  );
  await pair("catalog items — change", "update", `update public.customer_catalog_items set price = price where id = $1`, [catalogItem]);
  await pair(
    "meeting notes — create",
    "insert",
    `insert into public.meeting_notes (customer_id, owner_id, title, summary, source_kind, raw_source, model_used) values ($1, $2, 'Injected', 'S', 'Text', 'R', 'm')`,
    [ids.custA, ids.adminA],
  );
  await pair("meeting notes — change", "update", `update public.meeting_notes set title = title where id = $1`, [note]);
  await pair(
    "meeting note action items — create",
    "insert",
    `insert into public.meeting_note_action_items (customer_id, meeting_note_id, display_order, subject) values ($1, $2, 2, 'Injected')`,
    [ids.custA, note],
  );
  await pair("meeting note action items — change", "update", `update public.meeting_note_action_items set subject = subject where id = $1`, [actionItem]);
  await pair(
    "duplicate-contact dismissal — create",
    "insert",
    `insert into public.contact_duplicate_dismissals (customer_id, contact_id_a, contact_id_b) values ($1, $2, $3)`,
    [ids.custA, pairA, pairB],
  );

  const restart = async (...conns) => {
    for (const c of conns) {
      await c.query("rollback");
      await c.query("begin");
    }
  };
  await restart(appAdmin, oauthAdmin);

  // ===================================================================
  head("leads, tasks, contacts — 'Allow changes' OFF");
  // ===================================================================

  const writes = {
    "insert a lead": [`insert into public.leads (customer_id, contact_name, stage_id, owner_id) values ($1, 'Direct lead', $2, $3)`, [ids.custA, ids.stageA, ids.repA], "insert"],
    "update own lead": [`update public.leads set next_step = 'direct' where id = $1`, [ids.leadA], "update"],
    "insert a task": [`insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to) values ($1, $2, 'Direct task', current_date, $3)`, [ids.custA, ids.leadA, ids.repA], "insert"],
    "update own task": [`update public.tasks set subject = 'direct' where id = $1`, [task], "update"],
    "insert a contact": [`insert into public.contacts (customer_id, lead_id, owner_id, name) values ($1, $2, $3, 'Direct contact')`, [ids.custA, ids.leadA, ids.repA], "insert"],
    "update own contact": [`update public.contacts set title = 'direct' where id = $1`, [contactA], "update"],
  };
  const succeeded = (r, kind) => (kind === "insert" ? r.ok : r.ok && r.rowCount >= 1);

  for (const table of ["leads", "tasks", "contacts"]) {
    const viaOAuth = (await oauthRep.query(`select count(*)::int n from public.${table}`)).rows[0].n;
    const viaApp = (await appRep.query(`select count(*)::int n from public.${table}`)).rows[0].n;
    check(viaOAuth === viaApp && viaApp > 0, `reads are not restricted: the OAuth client sees the same ${table} as the app session (${viaOAuth}/${viaApp})`);
  }

  for (const [label, [sql, params, kind]] of Object.entries(writes)) {
    check(!succeeded(await attempt(oauthRep, sql, params), kind), `OAuth client (rep) cannot ${label} while 'Allow changes' is off`);
    check(succeeded(await attempt(appRep, sql, params), kind), `app session (rep) can still ${label}`);
  }
  // The app session's writes above hold row locks; release them.
  await restart(appRep, oauthRep);

  // ===================================================================
  head("leads, tasks, contacts — 'Allow changes' ON");
  // ===================================================================
  await db.query(`update public.customer_mcp_settings set allow_writes = true where customer_id = $1`, [ids.custA]);

  for (const [label, [sql, params, kind]] of Object.entries(writes)) {
    check(succeeded(await attempt(oauthRep, sql, params), kind), `OAuth client (rep) can ${label} once 'Allow changes' is on`);
  }
  check(
    !succeeded(await attempt(oauthRep, `update public.leads set next_step = 'x' where id = $1`, [ids.leadA2]), "update"),
    "existing RLS still applies: the rep cannot update a lead they do not own",
  );
  check(
    !succeeded(await attempt(oauthRep, `insert into public.leads (customer_id, contact_name, stage_id, owner_id) values ($1, 'x', $2, $3)`, [ids.custA, ids.stageA, ids.seniorA]), "insert"),
    "existing RLS still applies: the rep cannot create a lead owned by someone else",
  );
  check(
    !succeeded(await attempt(oauthAdmin, `update public.customer_mcp_settings set allow_writes = false where customer_id = $1`, [ids.custA]), "update"),
    "even with changes allowed, the OAuth client still cannot change MCP settings",
  );

  await db.query(`update public.customer_mcp_settings set enabled = false where customer_id = $1`, [ids.custA]);
  check(!succeeded(await attempt(oauthRep, ...writes["insert a task"].slice(0, 2)), "insert"), "with AI connections OFF, 'Allow changes' alone does not permit OAuth writes");
  await db.query(`update public.customer_mcp_settings set enabled = true where customer_id = $1`, [ids.custA]);

  // ===================================================================
  head("company isolation");
  // ===================================================================
  await db.query(`insert into public.customer_mcp_settings (customer_id, enabled, allow_writes) values ($1, true, true)`, [ids.custB]);
  check(
    !succeeded(await attempt(oauthAdminB, `insert into public.leads (customer_id, contact_name, stage_id) values ($1, 'cross', $2)`, [ids.custA, ids.stageA]), "insert"),
    "company B's OAuth admin cannot write leads into company A, even with B's changes allowed",
  );
  check(
    (await oauthRepB.query(`select public.mcp_oauth_writes_allowed($1) v`, [ids.custA])).rows[0].v === false,
    "mcp_oauth_writes_allowed discloses nothing about a company the caller does not belong to",
  );
  check((await oauthRepB.query(`select count(*)::int n from public.leads where customer_id = $1`, [ids.custA])).rows[0].n === 0, "company B's OAuth client still sees none of company A's leads");

  // ===================================================================
  head("what the MCP server itself does with the OAuth token still works");
  // ===================================================================
  check(
    (await attempt(oauthRep, `insert into public.mcp_audit_log (customer_id, customer_user_id, oauth_client_id, tool_name, status) values ($1, $2, 'oauth-client-1', 'search_leads', 'ok')`, [ids.custA, ids.repA])).ok,
    "audit rows can be written",
  );
  check(
    (await attempt(oauthRep, `insert into public.mcp_idempotency_keys (customer_id, customer_user_id, idempotency_key, tool_name) values ($1, $2, 'oauth-key-0001', 'create_task')`, [ids.custA, ids.repA])).ok &&
      (await attempt(oauthRep, `update public.mcp_idempotency_keys set status = 'failed' where idempotency_key = 'oauth-key-0001'`)).rowCount === 1,
    "idempotency reservations can be created and settled",
  );
  check(
    (await attempt(oauthRep, `update public.mcp_connections set last_used_at = now() where id = $1`, [connection])).rowCount === 1,
    "last use can be recorded on the person's own connection",
  );
  check(
    !(await attempt(oauthRep, `insert into public.mcp_connections (customer_id, customer_user_id, oauth_client_id, client_name, redirect_domain) values ($1, $2, 'oauth-client-2', 'Claude', 'claude.ai')`, [ids.custA, ids.repA])).ok,
    "but an OAuth client cannot register connections itself (only the consent screen can)",
  );
  check(
    (await attempt(appRep, `insert into public.mcp_connections (customer_id, customer_user_id, oauth_client_id, client_name, redirect_domain) values ($1, $2, 'oauth-client-3', 'Claude', 'claude.ai')`, [ids.custA, ids.repA])).ok,
    "the consent screen (app session) can still register connections",
  );
  check((await oauthRep.query(`select public.get_my_mcp_context('oauth-client-1') c`)).rows[0].c?.customer_id === ids.custA, "get_my_mcp_context still works for the OAuth client");

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error("review11 crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const c of openConnections) {
      await c.query("rollback").catch(() => {});
      await c.end().catch(() => {});
    }
  });
