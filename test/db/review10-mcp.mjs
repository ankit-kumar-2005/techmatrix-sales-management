import { asAnon, asUser, client, seed } from "./seed.mjs";

/**
 * MCP platform migration (20261010120000_mcp_platform.sql) under real RLS.
 *
 * Every assertion runs as a real `authenticated` connection with
 * auth.uid() bound to a seeded person — the same shape a PostgREST
 * request carrying that person's token has. The MCP server holds only the
 * user's own token, so these policies and triggers ARE its authorization
 * boundary for settings, blocks, connections, audit and idempotency.
 *
 *   Customer A: adminA, managerA -> seniorA -> repA, inactiveA (Inactive)
 *   Customer B: adminB, repB
 *
 * Findings from the security review are tagged (M1–M4, L1–L9) where a
 * check proves the correction.
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

/** Runs a statement and reports whether it was REJECTED (error) or not. */
async function rejects(conn, sql, params = []) {
  try {
    await conn.query("savepoint s");
    await conn.query(sql, params);
    await conn.query("release savepoint s");
    return false;
  } catch {
    await conn.query("rollback to savepoint s");
    return true;
  }
}

/** Closed on success AND on a crash — an open client keeps Node alive,
 *  which turns a failed assertion into a silent hang. */
const openConnections = [];

async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();

  const as = {};
  for (const key of ["adminA", "managerA", "seniorA", "repA", "inactiveA", "adminB", "repB"]) {
    as[key] = await asUser(ids[`${key}_auth`]);
    await as[key].query("begin");
  }
  const anon = await asAnon();
  await anon.query("begin");
  openConnections.push(db, anon, ...Object.values(as));

  const commit = async (...keys) => {
    for (const key of keys) {
      await as[key].query("commit");
      await as[key].query("begin");
    }
  };
  const ctx = async (who, clientId = null) =>
    (await as[who].query(`select public.get_my_mcp_context($1) as c`, [clientId])).rows[0].c;

  // ===================================================================
  head("customer_mcp_settings / customer_mcp_tools — admin only");
  // ===================================================================

  check(
    !(await rejects(as.adminA, `insert into public.customer_mcp_settings (customer_id, enabled) values ($1, true)`, [ids.custA])),
    "adminA can turn MCP on for customer A",
  );
  check(
    await rejects(as.managerA, `insert into public.customer_mcp_settings (customer_id, enabled) values ($1, true)`, [ids.custA]),
    "managerA cannot write customer A's MCP settings",
  );
  check(
    await rejects(as.adminA, `insert into public.customer_mcp_settings (customer_id, enabled) values ($1, true)`, [ids.custB]),
    "adminA cannot write customer B's MCP settings",
  );
  check(
    !(await rejects(as.adminA, `insert into public.customer_mcp_tools (customer_id, tool_name, enabled) values ($1, 'create_task', true)`, [ids.custA])),
    "adminA can enable a tool for customer A",
  );
  check(
    await rejects(as.adminA, `insert into public.customer_mcp_tools (customer_id, tool_name, enabled) values ($1, 'Drop Table', true)`, [ids.custA]),
    "a malformed tool name is rejected by the CHECK",
  );
  check(
    await rejects(as.seniorA, `insert into public.customer_mcp_tools (customer_id, tool_name, enabled) values ($1, 'update_task', true)`, [ids.custA]),
    "seniorA cannot change tool settings",
  );
  await commit("adminA");
  check((await as.repA.query(`select * from public.customer_mcp_settings`)).rowCount === 0, "repA cannot read the settings table directly");
  check((await as.adminB.query(`select * from public.customer_mcp_settings`)).rowCount === 0, "adminB cannot read customer A's settings");

  // ===================================================================
  head("get_my_mcp_context — the caller's own company, nothing else");
  // ===================================================================

  const repCtx = await ctx("repA");
  check(repCtx?.customer_id === ids.custA && repCtx?.customer_user_id === ids.repA, "repA's context resolves to repA's own membership in customer A");
  check(repCtx?.role === "SALES_REP", "the role comes from the live membership");
  check(repCtx?.mcp_enabled === true && repCtx?.allow_writes === false, "repA sees customer A's switches without reading the admin table");
  check(repCtx?.tool_overrides?.create_task === true, "repA sees customer A's tool overrides");
  check(repCtx?.person_blocked === false && repCtx?.connection === null, "not blocked, no connection before consent");
  const repBCtx = await ctx("repB");
  check(repBCtx?.customer_id === ids.custB && repBCtx?.mcp_enabled === false && JSON.stringify(repBCtx?.tool_overrides) === "{}", "repB sees only customer B's own (off) configuration");
  check((await ctx("inactiveA")) === null, "an Inactive member gets no context at all");
  check(await rejects(anon, `select public.get_my_mcp_context(null)`), "anon cannot call get_my_mcp_context");

  // ===================================================================
  head("mcp_user_blocks — per person, before the first connection (M4, L4)");
  // ===================================================================

  const blocked = await as.adminA.query(
    `insert into public.mcp_user_blocks (customer_id, customer_user_id, blocked_by, created_at)
     values ($1, $2, $3, now() - interval '1 year') returning blocked_by, created_at > now() - interval '1 minute' as fresh`,
    [ids.custA, ids.managerA, ids.adminB_auth],
  );
  check(blocked.rowCount === 1, "M4: adminA blocks managerA, who has never connected");
  check(blocked.rows[0].blocked_by === ids.adminA_auth && blocked.rows[0].fresh, "M4: blocked_by and created_at are stamped by the database, not taken from the request");
  await commit("adminA");

  check(
    await rejects(
      as.managerA,
      `insert into public.mcp_connections (customer_id, customer_user_id, oauth_client_id, client_name, redirect_domain) values ($1, $2, 'mgr-1', 'Claude', 'claude.ai')`,
      [ids.custA, ids.managerA],
    ),
    "M4: a person blocked before connecting cannot register their first connection",
  );
  check((await ctx("managerA"))?.person_blocked === true, "M4: the block is reported in the person's live context (enforced on every MCP request)");
  check((await ctx("managerA", "any-other-client"))?.person_blocked === true, "M4: the block applies whatever OAuth client the person uses");

  check((await as.managerA.query(`select * from public.mcp_user_blocks`)).rowCount === 0, "L4: the blocked person cannot read the blocks table");
  check((await as.repA.query(`select * from public.mcp_user_blocks`)).rowCount === 0, "L4: a colleague cannot read the blocks table");
  check((await as.adminB.query(`select * from public.mcp_user_blocks`)).rowCount === 0, "L4: another company's admin cannot read customer A's blocks");
  check((await as.managerA.query(`select public.mcp_caller_is_blocked() b`)).rows[0].b === true, "L4: mcp_caller_is_blocked tells the caller about themselves");
  check((await as.repA.query(`select public.mcp_caller_is_blocked() b`)).rows[0].b === false, "L4: and only about themselves (repA is not blocked)");
  check(await rejects(as.repA, `select public.mcp_is_person_blocked($1)`, [ids.managerA]), "L4: there is no function to ask about someone else's block");
  check(await rejects(anon, `select public.mcp_caller_is_blocked()`), "anon cannot call mcp_caller_is_blocked");

  check(
    await rejects(as.adminB, `insert into public.mcp_user_blocks (customer_id, customer_user_id) values ($1, $2)`, [ids.custA, ids.repA]),
    "M4: another company's admin cannot block a customer A member (RLS)",
  );
  check(
    await rejects(as.adminB, `insert into public.mcp_user_blocks (customer_id, customer_user_id) values ($1, $2)`, [ids.custB, ids.repA]),
    "M4: nor by claiming their own customer id (composite foreign key)",
  );
  check(
    await rejects(as.seniorA, `insert into public.mcp_user_blocks (customer_id, customer_user_id) values ($1, $2)`, [ids.custA, ids.repA]),
    "M4: a non-admin cannot block anyone",
  );
  check((await as.adminB.query(`delete from public.mcp_user_blocks where customer_user_id = $1`, [ids.managerA])).rowCount === 0, "M4: another company's admin cannot unblock");
  const selfUnblock = await as.managerA.query(`delete from public.mcp_user_blocks`);
  check(
    selfUnblock.rowCount === 0 && (await ctx("managerA"))?.person_blocked === true,
    "a person cannot unblock themselves (RLS hides the row; the block stays)",
  );

  const unblocked = await as.adminA.query(`delete from public.mcp_user_blocks where customer_user_id = $1`, [ids.managerA]);
  check(unblocked.rowCount === 1, "M4: adminA unblocks managerA");
  await commit("adminA");
  check(
    !(await rejects(
      as.managerA,
      `insert into public.mcp_connections (customer_id, customer_user_id, oauth_client_id, client_name, redirect_domain) values ($1, $2, 'mgr-1', 'Claude', 'claude.ai')`,
      [ids.custA, ids.managerA],
    )),
    "M4: once unblocked, they can connect",
  );
  await commit("managerA");

  // ===================================================================
  head("mcp_connections — ownership, tenancy, timestamps (L8)");
  // ===================================================================

  const insertConn = (who, cu, customerId, clientId, extraCols = "", extraVals = "") =>
    rejects(
      as[who],
      `insert into public.mcp_connections (customer_id, customer_user_id, oauth_client_id, client_name, redirect_domain${extraCols})
       values ($1, $2, $3, 'Claude', 'claude.ai'${extraVals})`,
      [customerId, cu, clientId],
    );

  check(!(await insertConn("repA", ids.repA, ids.custA, "rep-1")), "repA can register their own connection");
  check(await insertConn("repA", ids.seniorA, ids.custA, "x"), "repA cannot register a connection for seniorA");
  check(await insertConn("repA", ids.repA, ids.custB, "x"), "repA cannot register a connection under customer B");
  check(await insertConn("repA", ids.repA, ids.custA, "x", ", revoked_at", ", now()"), "a connection cannot be inserted already disconnected");
  check(await insertConn("repA", ids.repA, ids.custA, "x", ", last_used_at", ", now() + interval '1 year'"), "L8: last_used_at must start empty");
  check(await insertConn("inactiveA", ids.inactiveA, ids.custA, "x"), "an Inactive member cannot register a connection");
  await as.repA.query(
    `insert into public.mcp_connections (customer_id, customer_user_id, oauth_client_id, client_name, redirect_domain, created_at)
     values ($1, $2, 'rep-2', 'Claude', 'claude.ai', now() - interval '1 year')`,
    [ids.custA, ids.repA],
  );
  await commit("repA");
  const stamped = await db.query(`select created_at > now() - interval '1 minute' as fresh from public.mcp_connections where oauth_client_id = 'rep-2'`);
  check(stamped.rows[0].fresh === true, "L8: a back-dated created_at is overwritten by the database");

  const repCtxConn = await ctx("repA", "rep-1");
  check(repCtxConn?.connection?.revoked === false, "context reports repA's live connection");
  check((await ctx("repA", "mgr-1"))?.connection === null, "repA's context never reports another person's connection");

  check(
    (await as.managerA.query(`select customer_user_id from public.mcp_connections`)).rows.every((r) => r.customer_user_id === ids.managerA),
    "managerA (not an admin) sees only their own connections, not their reports'",
  );
  check((await as.adminA.query(`select 1 from public.mcp_connections`)).rowCount === 3, "adminA sees every connection in customer A");
  check((await as.adminB.query(`select 1 from public.mcp_connections`)).rowCount === 0, "adminB sees no connections from customer A");

  check(
    await rejects(as.repA, `update public.mcp_connections set oauth_client_id = 'other' where oauth_client_id = 'rep-1'`),
    "a connection's client id is immutable",
  );
  check(
    !(await rejects(as.repA, `update public.mcp_connections set last_used_at = now() where oauth_client_id = 'rep-1'`)),
    "L8: the owner (the MCP server, as them) can record last use",
  );
  check(
    (await as.adminA.query(`update public.mcp_connections set last_used_at = now() where customer_user_id = $1`, [ids.repA])).rowCount === 0,
    "an admin cannot change anyone's connection row",
  );
  await commit("repA");

  // ===================================================================
  head("disconnect is one-way (M3)");
  // ===================================================================

  check(
    !(await rejects(as.repA, `update public.mcp_connections set revoked_at = now() where oauth_client_id = 'rep-1'`)),
    "repA disconnects their own connection",
  );
  await commit("repA");
  check((await ctx("repA", "rep-1"))?.connection?.revoked === true, "M3: the next request's context sees the disconnect");
  check(
    await rejects(as.repA, `update public.mcp_connections set revoked_at = null where oauth_client_id = 'rep-1'`),
    "M3: the owner (or a stolen token) cannot clear the disconnect",
  );
  check(
    await rejects(as.repA, `update public.mcp_connections set revoked_at = now() + interval '1 day' where oauth_client_id = 'rep-1'`),
    "M3: nor move it",
  );
  check(
    (await as.adminA.query(`update public.mcp_connections set revoked_at = null where oauth_client_id = 'rep-1'`)).rowCount === 0,
    "M3: an admin cannot clear it either",
  );
  check(await insertConn("repA", ids.repA, ids.custA, "rep-1"), "M3: a fresh row for the same (person, client) cannot be inserted");
  check(!(await insertConn("repA", ids.repA, ids.custA, "rep-3")), "M3: reconnecting with a NEW OAuth client works");
  check(await rejects(as.repA, `delete from public.mcp_connections`), "no one can delete a connection");
  await commit("repA");

  // ===================================================================
  head("mcp_audit_log — insert-only, attributable, hashed keys (L6)");
  // ===================================================================

  const insertAudit = (who, cu, customerId, extraCols = "", extraVals = "", params = []) =>
    rejects(
      as[who],
      `insert into public.mcp_audit_log (customer_id, customer_user_id, oauth_client_id, tool_name, status${extraCols})
       values ($1, $2, 'rep-1', 'search_leads', 'ok'${extraVals})`,
      [customerId, cu, ...params],
    );

  check(!(await insertAudit("seniorA", ids.seniorA, ids.custA)), "seniorA can record their own activity");
  check(await insertAudit("seniorA", ids.repA, ids.custA), "seniorA cannot record activity as repA");
  check(await insertAudit("repB", ids.repA, ids.custA), "repB cannot record activity into customer A");
  check(await insertAudit("seniorA", ids.seniorA, ids.custB), "seniorA cannot record their own activity into customer B");
  check(
    await rejects(
      as.seniorA,
      `insert into public.mcp_audit_log (customer_id, customer_user_id, oauth_client_id, tool_name, status) values ($1, $2, 'c', 'search_leads', 'hacked')`,
      [ids.custA, ids.seniorA],
    ),
    "an unknown status is rejected",
  );
  check(
    await insertAudit("seniorA", ids.seniorA, ids.custA, ", idempotency_key", ", 'raw-key-value'"),
    "L6: there is no column for a raw idempotency key",
  );
  check(
    await insertAudit("seniorA", ids.seniorA, ids.custA, ", idempotency_key_sha256", ", 'priya.shah:9876543210'"),
    "L6: anything but a SHA-256 hex digest is refused in the hash column",
  );
  check(
    !(await insertAudit("seniorA", ids.seniorA, ids.custA, ", idempotency_key_sha256", ", $3", ["a".repeat(64)])),
    "L6: a SHA-256 hex digest is accepted",
  );
  await as.seniorA.query(
    `insert into public.mcp_audit_log (customer_id, customer_user_id, oauth_client_id, tool_name, status, created_at)
     values ($1, $2, 'c', 'search_leads', 'ok', now() - interval '30 days')`,
    [ids.custA, ids.seniorA],
  );
  await commit("seniorA");
  const fresh = await db.query(`select min(created_at) > now() - interval '1 minute' as fresh from public.mcp_audit_log`);
  check(fresh.rows[0].fresh === true, "a back-dated created_at is overwritten with now()");
  check(await rejects(as.seniorA, `update public.mcp_audit_log set status = 'denied'`), "audit rows cannot be updated");
  check(await rejects(as.seniorA, `delete from public.mcp_audit_log`), "audit rows cannot be deleted");
  check((await as.adminA.query(`select 1 from public.mcp_audit_log`)).rowCount === 3, "adminA sees customer A's activity");
  check((await as.managerA.query(`select 1 from public.mcp_audit_log`)).rowCount === 0, "managerA does not see a report's activity (admins and the person only)");
  check((await as.adminB.query(`select 1 from public.mcp_audit_log`)).rowCount === 0, "adminB sees none of customer A's activity");

  // ===================================================================
  head("mcp_idempotency_keys — pending first, approved transitions only (L1)");
  // ===================================================================

  const reserve = (who, cu, customerId, key, extraCols = "", extraVals = "") =>
    rejects(
      as[who],
      `insert into public.mcp_idempotency_keys (customer_id, customer_user_id, idempotency_key, tool_name${extraCols})
       values ($1, $2, $3, 'create_task'${extraVals})`,
      [customerId, cu, key],
    );

  check(await reserve("managerA", ids.managerA, ids.custA, "forged-0001", ", status, record_id", ", 'succeeded', gen_random_uuid()"), "L1: a reservation cannot start 'succeeded'");
  check(await reserve("managerA", ids.managerA, ids.custA, "forged-0002", ", status", ", 'failed'"), "L1: nor 'failed'");
  check(await reserve("managerA", ids.managerA, ids.custA, "forged-0003", ", record_id", ", gen_random_uuid()"), "L1: nor with a record id");
  check(!(await reserve("managerA", ids.managerA, ids.custA, "key-00000001", ", created_at", ", now() - interval '1 year'")), "managerA reserves a key");
  await commit("managerA");
  const reservation = await db.query(`select created_at > now() - interval '1 minute' as fresh from public.mcp_idempotency_keys where idempotency_key = 'key-00000001'`);
  check(reservation.rows[0].fresh === true, "L1/L2: created_at is stamped by the database (stale detection cannot be faked)");
  check(await reserve("managerA", ids.managerA, ids.custA, "key-00000001"), "the same key a second time is rejected (unique)");
  check(await reserve("seniorA", ids.seniorA, ids.custA, "key-00000001"), "another person in the same customer cannot reuse the key");
  check((await as.seniorA.query(`select * from public.mcp_idempotency_keys`)).rowCount === 0, "and cannot read managerA's reservation");
  check(!(await reserve("repB", ids.repB, ids.custB, "key-00000001")), "a different customer may use the same key string");
  check(await reserve("managerA", ids.managerA, ids.custA, "short"), "a key shorter than 8 characters is rejected");

  const update = (sql) => rejects(as.managerA, `update public.mcp_idempotency_keys set ${sql} where idempotency_key = 'key-00000001'`);
  check(await update(`idempotency_key = 'key-99999999'`), "a reservation's key is immutable");
  check(await update(`record_id = gen_random_uuid()`), "L1: a pending reservation's record id cannot be set without completing it");
  check(await update(`status = 'failed', record_id = gen_random_uuid()`), "L1: a failure cannot carry a record id");
  check(!(await update(`status = 'failed'`)), "L1: pending -> failed is allowed");
  check(!(await update(`status = 'pending'`)), "L1: failed -> pending (a retry) is allowed");
  check(!(await update(`status = 'succeeded', record_id = gen_random_uuid()`)), "L1: pending -> succeeded with the created id is allowed");
  check(await update(`record_id = gen_random_uuid()`), "L1: a succeeded reservation's record id can never change");
  check(await update(`status = 'pending', record_id = null`), "L1: a succeeded reservation can never be reopened");
  check(await update(`status = 'failed'`), "L1: nor marked failed");

  // ===================================================================
  head("session liveness — a signed-out token is refused on the next request (R3)");
  // ===================================================================

  const sessionState = async (conn) => (await conn.query(`select public.get_my_mcp_context(null) as c`)).rows[0].c?.session_state;
  const repSession = await asUser(ids.repA_auth);
  openConnections.push(repSession);
  await repSession.query("begin");
  const setSessionClaim = (value) => repSession.query(`select set_config('request.jwt.claim.session_id', $1, false)`, [value]);

  check((await sessionState(as.repA)) === "missing_claim", "R3: a token without a session_id cannot be verified (MCP refuses it)");

  const liveSession = (await db.query(`insert into auth.sessions (user_id) values ($1) returning id`, [ids.repA_auth])).rows[0].id;
  await setSessionClaim(liveSession);
  check((await sessionState(repSession)) === "active", "R3: a token whose session still exists is active");

  await db.query(`update auth.sessions set not_after = now() - interval '1 minute' where id = $1`, [liveSession]);
  check((await sessionState(repSession)) === "ended", "R3: a session past its time-box (not_after) is ended");
  await db.query(`update auth.sessions set not_after = null where id = $1`, [liveSession]);
  check((await sessionState(repSession)) === "active", "R3: (time-box cleared: active again)");

  await db.query(`delete from auth.sessions where id = $1`, [liveSession]);
  check((await sessionState(repSession)) === "ended", "R3: sign-out (Supabase deletes the session row) ends the token on the next request");

  const managersSession = (await db.query(`insert into auth.sessions (user_id) values ($1) returning id`, [ids.managerA_auth])).rows[0].id;
  await setSessionClaim(managersSession);
  check((await sessionState(repSession)) === "ended", "R3: another user's session id is not accepted");

  await setSessionClaim("not-a-uuid");
  check((await sessionState(repSession)) === "missing_claim", "R3: a malformed session_id cannot be verified");

  const secondSession = (await db.query(`insert into auth.sessions (user_id) values ($1) returning id`, [ids.repA_auth])).rows[0].id;
  await setSessionClaim(secondSession);
  await db.query(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [ids.repA_auth]);
  check((await sessionState(repSession)) === "ended", "R3: a banned user's live session is ended");
  await db.query(`update auth.users set banned_until = now() - interval '1 day' where id = $1`, [ids.repA_auth]);
  check((await sessionState(repSession)) === "active", "R3: an expired ban no longer applies");

  check(await rejects(repSession, `select id from auth.sessions`), "R3: users cannot read auth.sessions directly (only the definer function checks it)");

  // ===================================================================
  head("audit history survives deleting the person (M2)");
  // ===================================================================

  // End every user transaction first: their row locks would block the delete.
  for (const c of [...Object.values(as), anon, repSession]) await c.query("rollback");

  await db.query("begin");
  const before = await db.query(`select count(*)::int n from public.mcp_audit_log where customer_user_id = $1`, [ids.seniorA]);
  await db.query(`delete from auth.users where id = $1`, [ids.seniorA_auth]);
  const membershipGone = await db.query(`select count(*)::int n from public.customer_users where id = $1`, [ids.seniorA]);
  const after = await db.query(`select count(*)::int n from public.mcp_audit_log where customer_user_id = $1`, [ids.seniorA]);
  check(membershipGone.rows[0].n === 0, "M2: deleting the auth user removes the membership (existing cascade)");
  check(before.rows[0].n === 3 && after.rows[0].n === 3, `M2: the person's audit rows are kept (${before.rows[0].n} -> ${after.rows[0].n})`);
  await db.query("rollback");

  // Company deletion: read the foreign keys from the catalog (a real
  // customer delete also exercises unrelated lead triggers).
  const fks = await db.query(`
    select c.conrelid::regclass::text as tbl, c.confrelid::regclass::text as ref, c.confdeltype as on_delete
    from pg_constraint c
    where c.contype = 'f' and c.conrelid = 'public.mcp_audit_log'::regclass`);
  const toCustomers = fks.rows.find((r) => r.ref === "customers");
  check(toCustomers?.on_delete === "c", "M2: mcp_audit_log still cascades when the whole customer is deleted");
  check(!fks.rows.some((r) => r.ref === "customer_users"), "M2: mcp_audit_log has no foreign key to customer_users (history outlives the membership)");

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error("review10 crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const c of openConnections) {
      await c.query("rollback").catch(() => {});
      await c.end().catch(() => {});
    }
  });
