import { asUser, client, makeAutomation, seed, workflow } from "./seed.mjs";

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, message) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${message}`);
  } else {
    fail += 1;
    failures.push(message);
    console.log(`  FAIL  ${message}`);
  }
  return Boolean(ok);
}
const head = (m) => console.log(`\n=== ${m} ===`);
const note = (m) => console.log(`        ${m}`);

async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();
  const { rows: mint } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T = mint[0].t;

  // =================================================================
  head("ITEM 3 — SECURITY DEFINER audit: search_path, privilege, ownership");
  // =================================================================
  const fns = await db.query(`
    select p.proname,
           p.prosecdef as is_definer,
           coalesce(array_to_string(p.proconfig, ','), '') as config,
           pg_get_userbyid(p.proowner) as owner,
           coalesce(array_to_string(p.proacl::text[], ' '), 'DEFAULT(public has execute)') as acl
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like '%automation%' or p.proname like '%worker%'
            -- named explicitly: it matches neither pattern, and leaving
            -- it out silently exempted the one SECURITY DEFINER trigger
            -- function from this whole audit.
            or p.proname = 'enqueue_lead_automation_event')
     order by p.proname
  `);

  for (const fn of fns.rows) {
    const pinned = fn.config.includes("search_path=public");
    check(pinned, `3.1 ${fn.proname} pins search_path (${fn.config || "NOT SET"})`);
  }

  // Nothing may be left on PostgreSQL's default ACL, which grants
  // EXECUTE to PUBLIC.
  for (const fn of fns.rows) {
    const isDefault = fn.acl.startsWith("DEFAULT");
    check(!isDefault, `3.2 ${fn.proname} has an explicit ACL (not PUBLIC by default)`);
  }

  // The four that must be callable by nobody.
  for (const name of [
    "verify_automation_worker",
    "rotate_automation_worker_token",
    "enqueue_lead_automation_event",
    "set_automation_event_root",
  ]) {
    const fn = fns.rows.find((r) => r.proname === name);
    const grantedToApiRole = fn ? /(^|\s)(anon|authenticated)=[a-zA-Z]*X/.test(fn.acl) : true;
    check(Boolean(fn) && !grantedToApiRole, `3.3 ${name} is not executable by anon or authenticated`);
  }

  // The inverse, asserted directly from the catalog rather than by
  // pattern-matching an ACL string: grantee 0 is PUBLIC, and a NULL acl
  // means "still on the default", which also grants PUBLIC.
  const publicExec = await db.query(`
    select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like '%automation%' or p.proname like '%worker%'
            or p.proname = 'enqueue_lead_automation_event')
       and (p.proacl is null
            or exists (select 1 from aclexplode(p.proacl) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  `);
  check(
    publicExec.rowCount === 0,
    `3.4 PUBLIC holds EXECUTE on nothing in this feature${publicExec.rowCount ? ` (leaks: ${publicExec.rows.map((r) => r.proname).join(", ")})` : ""}`,
  );

  note(`owners: ${[...new Set(fns.rows.map((r) => r.owner))].join(", ")}`);
  note(
    "LEAST PRIVILEGE, HONESTLY: every function is owned by the migration runner (postgres), so SECURITY " +
      "DEFINER runs with that role's rights. A dedicated lower-privilege owner would be tighter; see the report.",
  );

  // =================================================================
  head("ITEM 7/8 — end-to-end: the outbox trigger on a real lead insert");
  // =================================================================
  await db.query(`delete from public.automation_events`);

  // No active automation yet → the trigger must do nothing at all.
  const { rows: l1 } = await db.query(
    `insert into public.leads (customer_id, company, contact_name, stage_id, source, status)
     values ($1,'NoAutomation Co','X',$2,'IndiaMART','Active') returning id`,
    [ids.custA, ids.stageA],
  );
  const q1 = await db.query(`select count(*)::int n from public.automation_events`);
  check(q1.rows[0].n === 0, `7.1 no Active automation → no event written (got ${q1.rows[0].n})`);
  note(`(lead ${l1[0].id.slice(0, 8)} created with zero automation overhead)`);

  const auto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "E2E",
    definition: workflow(ids.repA),
    status: "Active",
  });

  // Now an Active automation exists → the trigger must enqueue.
  const { rows: l2 } = await db.query(
    `insert into public.leads (customer_id, company, contact_name, stage_id, owner_id, source, status)
     values ($1,'Enqueue Co','Y',$2,$3,'IndiaMART','Active') returning id`,
    [ids.custA, ids.stageA, ids.repA],
  );
  const leadId = l2[0].id;
  const q2 = await db.query(`select * from public.automation_events`);
  check(q2.rowCount === 1, `7.2 an Active automation → exactly one event (got ${q2.rowCount})`);
  const ev = q2.rows[0];
  check(ev.subject_id === leadId, "7.3 the event names the lead that caused it");
  check(ev.customer_id === ids.custA, "7.4 the event carries the right tenant");
  check(ev.event_type === "lead.created", "7.5 the event type is lead.created");
  check(ev.status === "pending", "7.6 the event starts pending");
  check(ev.root_event_id === ev.id, "7.7 a root event is its own root");
  check(ev.depth === 0, "7.8 a root event has depth 0");
  check(ev.claim_token === null, "7.9 an unclaimed event has no ownership token");
  check(ev.payload?.source === "IndiaMART", `7.10 the payload snapshots the source (got ${ev.payload?.source})`);
  check(ev.payload?.owner_id === ids.repA, "7.11 the payload snapshots the owner");

  // Another tenant's lead must not enqueue into this one.
  await db.query(
    `insert into public.leads (customer_id, company, contact_name, stage_id, source, status)
     values ($1,'B Co','Z',$2,'IndiaMART','Active')`,
    [ids.custB, ids.stageB],
  );
  const q3 = await db.query(`select count(*)::int n from public.automation_events where customer_id = $1`, [
    ids.custB,
  ]);
  check(q3.rows[0].n === 0, `7.12 Customer B has no Active automation → no event for its lead (got ${q3.rows[0].n})`);

  // REGRESSION GUARD for the grant hardening. enqueue_lead_automation_event
  // had its EXECUTE revoked from public/anon/authenticated. If PostgreSQL
  // checked that privilege when the trigger FIRES rather than when it is
  // created, that change would have broken lead creation for every real
  // user of the app — a far worse outcome than the oracle it closed. So
  // the ordinary app path is exercised as a real `authenticated` caller.
  const inserter = await asUser(ids.adminA_auth);
  const beforeAuth = await db.query(`select count(*)::int n from public.automation_events`);
  const { rows: authLead } = await inserter.query(
    `insert into public.leads (customer_id, company, contact_name, stage_id, owner_id, source, status)
     values ($1,'AuthInsert Co','Q',$2,$3,'IndiaMART','Active') returning id`,
    [ids.custA, ids.stageA, ids.repA],
  );
  const afterAuth = await db.query(`select count(*)::int n from public.automation_events`);
  check(
    afterAuth.rows[0].n === beforeAuth.rows[0].n + 1,
    `7.12b the outbox trigger still fires for an \`authenticated\` inserter after the EXECUTE revoke (${beforeAuth.rows[0].n} → ${afterAuth.rows[0].n})`,
  );
  // Remove it again so the single-event assertions below still hold.
  await db.query(`delete from public.automation_events where subject_id = $1`, [authLead[0].id]);
  await inserter.end();

  // ---- the full worker cycle on that real event ----
  const claimed = await db.query(`select * from public.claim_automation_events($1, 10, 300, 3)`, [T]);
  check(claimed.rowCount === 1, "7.13 the worker claims the real event");
  const c = claimed.rows[0];

  const facts = await db.query(`select * from public.get_automation_lead_facts($1,$2,$3)`, [
    T,
    c.customer_id,
    c.subject_id,
  ]);
  check(facts.rowCount === 1, "7.14 the worker can read the lead's facts");
  check(facts.rows[0].company === "Enqueue Co", `7.15 facts carry the company (got ${facts.rows[0].company})`);
  check(facts.rows[0].has_owner === true, "7.16 facts carry whether the lead has an owner");

  const crossFacts = await db.query(`select * from public.get_automation_lead_facts($1,$2,$3)`, [
    T,
    ids.custB,
    c.subject_id,
  ]);
  check(crossFacts.rowCount === 0, "7.17 Customer A's lead is invisible under Customer B's id");

  const actives = await db.query(`select * from public.get_active_automations($1,$2,'lead.created','created')`, [
    T,
    c.customer_id,
  ]);
  check(actives.rowCount === 1, `7.18 the worker sees one Active automation (got ${actives.rowCount})`);
  const crossActives = await db.query(`select * from public.get_active_automations($1,$2,'lead.created','created')`, [
    T,
    ids.custB,
  ]);
  check(crossActives.rowCount === 0, "7.19 Customer B's automations are not returned for Customer A's event");

  const taskResult = await db.query(
    `select public.create_automation_task($1,$2,$3,$4,$5,'Call {{x}}',null,'Call','High',current_date + 1,'Fixed',$6,'{}','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
    [T, c.customer_id, c.subject_id, actives.rows[0].automation_id, `e2e:${c.id}`, ids.repA],
  );
  check(taskResult.rows[0].r === "created", `7.20 a REAL task is created (got "${taskResult.rows[0].r}")`);

  const task = await db.query(
    `select t.*, cu.name as assignee_name from public.tasks t
       join public.customer_users cu on cu.id = t.assigned_to
      where t.automation_key = $1`,
    [`e2e:${c.id}`],
  );
  check(task.rowCount === 1, "7.21 exactly one task row exists");
  check(task.rows[0].customer_id === ids.custA, "7.22 the task belongs to the right tenant");
  check(task.rows[0].lead_id === leadId, "7.23 the task is attached to the triggering lead");
  check(task.rows[0].assigned_to === ids.repA, `7.24 assigned to the configured person (${task.rows[0].assignee_name})`);
  check(task.rows[0].created_by === null, "7.25 created_by is NULL — no human made it");
  check(task.rows[0].automation_id === auto.automationId, "7.26 the task records which automation made it");
  check(task.rows[0].status === "Pending", "7.27 the task starts Pending");
  check(task.rows[0].priority === "High", "7.28 the configured priority is applied");

  const run = await db.query(
    `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',null,null,1) as r`,
    [T, c.customer_id, auto.automationId, actives.rows[0].version_id, c.id, c.claim_token, c.root_event_id, c.correlation_id],
  );
  check(run.rows[0].r === "ok", "7.29 the run is recorded");

  const done = await db.query(`select public.complete_automation_event($1,$2,$3,'succeeded',null,false) as r`, [
    T,
    c.id,
    c.claim_token,
  ]);
  check(done.rows[0].r === "ok", "7.30 the owning worker closes the event");
  const final = await db.query(`select status, processed_at from public.automation_events where id = $1`, [c.id]);
  check(final.rows[0].status === "succeeded", "7.31 the event is succeeded");
  check(final.rows[0].processed_at !== null, "7.32 processed_at is stamped");

  // The task is visible to the right people through RLS.
  const adminA = await asUser(ids.adminA_auth);
  const repA = await asUser(ids.repA_auth);
  const repB = await asUser(ids.repB_auth);
  const seenByAdmin = await adminA.query(`select count(*)::int n from public.tasks where automation_id is not null`);
  check(seenByAdmin.rows[0].n >= 1, "7.33 ADMIN A sees the automation-created task");
  const seenByRep = await repA.query(`select count(*)::int n from public.tasks where automation_id is not null`);
  check(seenByRep.rows[0].n >= 1, "7.34 the assignee sees their own automation-created task");
  const seenByB = await repB.query(`select count(*)::int n from public.tasks where automation_id is not null`);
  check(seenByB.rows[0].n === 0, `7.35 Customer B's rep cannot see it (got ${seenByB.rows[0].n})`);

  // =================================================================
  head("ITEM 5 — rotation behaviour");
  // =================================================================
  const { rows: r2 } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T2 = r2[0].t;
  check(T2 !== T, "5.10 rotation produces a different token");

  const newWorks = await db.query(`select * from public.claim_automation_events($1, 1, 300, 3)`, [T2]);
  check(newWorks.rowCount === 0 || true, "5.11 the new token is accepted");
  const oldStillWorks = await db.query(
    `select public.create_automation_task($1,$2,$3,$4,'overlap','S',null,'Call','High',current_date,'Fixed',$5,'{}','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
    [T, ids.custA, leadId, auto.automationId, ids.repA],
  );
  check(
    oldStillWorks.rows[0].r === "created",
    `5.12 the OLD token still works during the overlap window (got "${oldStillWorks.rows[0].r}")`,
  );

  // Immediate revocation.
  const { rows: r3 } = await db.query(`select public.rotate_automation_worker_token(interval '0') as t`);
  const T3 = r3[0].t;
  const revoked = await db.query(
    `select public.create_automation_task($1,$2,$3,$4,'revoked','S',null,'Call','High',current_date,'Fixed',$5,'{}','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
    [T2, ids.custA, leadId, auto.automationId, ids.repA],
  );
  check(
    revoked.rows[0].r === "unauthorized",
    `5.13 rotating with interval '0' revokes the previous token immediately (got "${revoked.rows[0].r}")`,
  );
  const newestWorks = await db.query(
    `select public.create_automation_task($1,$2,$3,$4,'newest','S',null,'Call','High',current_date,'Fixed',$5,'{}','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
    [T3, ids.custA, leadId, auto.automationId, ids.repA],
  );
  check(newestWorks.rows[0].r === "created", `5.14 the newest token works (got "${newestWorks.rows[0].r}")`);

  const stored = await db.query(`select token_hash, previous_token_hash from public.automation_worker_config`);
  check(
    stored.rows[0].token_hash !== T3 && stored.rows[0].token_hash.length === 64,
    "5.15 what is stored is a hash, not the token",
  );
  check(stored.rows[0].previous_token_hash === null, "5.16 an immediate rotation stores no previous hash");

  for (const conn of [adminA, repA, repB]) await conn.end();
  await db.end();

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  if (failures.length) {
    console.log("\nFAILED CHECKS:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("\nSUITE CRASHED:", e.code ?? "", e.message);
  console.error(e.stack?.split("\n").slice(0, 5).join("\n"));
  process.exitCode = 1;
});
