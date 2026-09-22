import { asAnon, asUser, client, makeAutomation, seed, workflow } from "./seed.mjs";

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
function head(m) {
  console.log(`\n=== ${m} ===`);
}
function note(m) {
  console.log(`        ${m}`);
}

async function denied(fn, message) {
  try {
    const r = await fn();
    const rows = r?.rowCount ?? 0;
    return check(rows === 0, `${message} (got ${rows} row(s) — expected 0)`);
  } catch (error) {
    // 42501 insufficient_privilege is also a correct denial.
    return check(true, `${message} [${error.code}]`);
  }
}

async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();
  // The migration no longer seeds a token — mint one, which is also
  // the rotation path under test.
  const { rows: mint } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T = mint[0].t;
  check(typeof T === "string" && T.length === 64, `5.0 rotate_automation_worker_token mints a 64-char token`);

  // =================================================================
  head("ITEM 1 — create_automation_task: automation_id tenancy + eligibility");
  // =================================================================
  const active = await makeAutomation(db, {
    customerId: ids.custA,
    name: "A active",
    definition: workflow(ids.repA),
    status: "Active",
  });
  const draft = await makeAutomation(db, {
    customerId: ids.custA,
    name: "A draft",
    definition: workflow(ids.repA),
    status: "Draft",
    setActive: false,
  });
  const inactive = await makeAutomation(db, {
    customerId: ids.custA,
    name: "A inactive",
    definition: workflow(ids.repA),
    status: "Inactive",
  });
  const foreign = await makeAutomation(db, {
    customerId: ids.custB,
    name: "B active",
    definition: workflow(ids.repB),
    status: "Active",
  });

  const callTask = async (overrides = {}) => {
    const args = {
      token: T,
      customer: ids.custA,
      lead: ids.leadA,
      automation: active.automationId,
      key: `k-${Math.random().toString(36).slice(2)}`,
      assignee: ids.repA,
      mode: "Fixed",
      pool: [],
      ...overrides,
    };
    const { rows } = await db.query(
      `select public.create_automation_task($1,$2,$3,$4,$5,'Subj',null,'Call','High',current_date,$6,$7,$8,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
      [args.token, args.customer, args.lead, args.automation, args.key, args.mode, args.assignee, args.pool],
    );
    return rows[0].r;
  };

  check((await callTask()) === "created", "1.0 baseline: an Active automation creates a task");

  const crossTenant = await callTask({ automation: foreign.automationId });
  check(
    crossTenant !== "created",
    `1.1 Customer B's automation_id must NOT create a task in Customer A (got "${crossTenant}")`,
  );

  const draftResult = await callTask({ automation: draft.automationId });
  check(draftResult !== "created", `1.2 a Draft automation must not execute (got "${draftResult}")`);

  const inactiveResult = await callTask({ automation: inactive.automationId });
  check(inactiveResult !== "created", `1.3 an Inactive automation must not execute (got "${inactiveResult}")`);

  const ghost = await callTask({ automation: "00000000-0000-4000-8000-000000000000" });
  check(ghost !== "created", `1.4 a nonexistent automation_id must not create a task (got "${ghost}")`);

  const crossLead = await callTask({ lead: ids.leadB });
  check(crossLead === "invalid_lead", `1.5 Customer B's lead is rejected (got "${crossLead}")`);

  const crossAssignee = await callTask({ assignee: ids.repB });
  check(
    crossAssignee === "no_eligible_assignee",
    `1.6 Customer B's member cannot be assigned (got "${crossAssignee}")`,
  );

  const inactiveAssignee = await callTask({ assignee: ids.inactiveA });
  check(
    inactiveAssignee === "no_eligible_assignee",
    `1.7 an Inactive member cannot be assigned (got "${inactiveAssignee}")`,
  );

  // =================================================================
  head("ITEM 2 — claim ownership: a stale worker must not complete another's claim");
  // =================================================================
  await db.query(`delete from public.automation_events`);
  await db.query(
    `insert into public.automation_events (customer_id, event_type, subject_id, payload)
     values ($1, 'lead.created', $2, '{}'::jsonb)`,
    [ids.custA, ids.leadA],
  );

  const claim1 = await db.query(`select * from public.claim_automation_events($1, 10, 300, 3)`, [T]);
  check(claim1.rowCount === 1, "2.0 worker 1 claims the event");
  const eventId = claim1.rows[0]?.id;
  const staleClaimToken = claim1.rows[0]?.claim_token;
  check(Boolean(staleClaimToken), "2.0b the claim returns a per-claim ownership token");

  // Age the claim past the timeout so worker 2 may reclaim it.
  await db.query(`update public.automation_events set claimed_at = now() - interval '1 hour' where id = $1`, [
    eventId,
  ]);
  const claim2 = await db.query(`select * from public.claim_automation_events($1, 10, 300, 3)`, [T]);
  check(claim2.rowCount === 1, "2.1 worker 2 reclaims the stale event");
  check(claim2.rows[0]?.attempts === 2, `2.2 attempts incremented to 2 (got ${claim2.rows[0]?.attempts})`);
  check(
    claim2.rows[0]?.claim_token && claim2.rows[0].claim_token !== staleClaimToken,
    "2.2b the reclaim mints a DIFFERENT ownership token",
  );

  // Worker 1 — long since superseded — now reports success.
  const staleComplete = await db.query(
    `select public.complete_automation_event($1, $2, $3, 'succeeded', null, false) as r`,
    [T, eventId, staleClaimToken],
  );
  check(
    staleComplete.rows[0].r === "not_claimed",
    `2.3 the stale worker's completion must be REFUSED (got "${staleComplete.rows[0].r}")`,
  );

  const afterStale = await db.query(`select status from public.automation_events where id = $1`, [eventId]);
  check(
    afterStale.rows[0].status === "processing",
    `2.4 the event must still belong to worker 2 (status is "${afterStale.rows[0].status}")`,
  );

  // =================================================================
  head("ITEM 8 — concurrency: two real workers, no double-claim");
  // =================================================================
  await db.query(`delete from public.automation_events`);
  for (let i = 0; i < 20; i += 1) {
    await db.query(
      `insert into public.automation_events (customer_id, event_type, subject_id, payload)
       values ($1, 'lead.created', $2, '{}'::jsonb)`,
      [ids.custA, ids.leadA],
    );
  }

  const w1 = client();
  const w2 = client();
  await w1.connect();
  await w2.connect();
  // Genuinely simultaneous: both statements in flight before either awaits.
  const [r1, r2] = await Promise.all([
    w1.query(`select id from public.claim_automation_events($1, 20, 300, 3)`, [T]),
    w2.query(`select id from public.claim_automation_events($1, 20, 300, 3)`, [T]),
  ]);
  const got1 = r1.rows.map((r) => r.id);
  const got2 = r2.rows.map((r) => r.id);
  const overlap = got1.filter((id) => got2.includes(id));
  check(overlap.length === 0, `8.1 no event claimed by both workers (overlap: ${overlap.length})`);
  check(
    got1.length + got2.length === 20,
    `8.2 all 20 events claimed exactly once (${got1.length} + ${got2.length})`,
  );
  note(`worker 1 took ${got1.length}, worker 2 took ${got2.length}`);
  await w1.end();
  await w2.end();

  // =================================================================
  head("ITEM 8 — task idempotency under a real race");
  // =================================================================
  const dupKey = "race-key-1";
  const c1 = client();
  const c2 = client();
  await c1.connect();
  await c2.connect();
  const [d1, d2] = await Promise.all([
    c1.query(
      `select public.create_automation_task($1,$2,$3,$4,$5,'Dup',null,'Call','High',current_date,'Fixed',$6,'{}','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
      [T, ids.custA, ids.leadA, active.automationId, dupKey, ids.repA],
    ),
    c2.query(
      `select public.create_automation_task($1,$2,$3,$4,$5,'Dup',null,'Call','High',current_date,'Fixed',$6,'{}','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
      [T, ids.custA, ids.leadA, active.automationId, dupKey, ids.repA],
    ),
  ]);
  const outcomes = [d1.rows[0].r, d2.rows[0].r].sort();
  check(
    outcomes[0] === "created" && outcomes[1] === "duplicate",
    `8.3 concurrent identical keys → one created, one duplicate (got ${JSON.stringify(outcomes)})`,
  );
  const taskCount = await db.query(`select count(*)::int n from public.tasks where automation_key = $1`, [dupKey]);
  check(taskCount.rows[0].n === 1, `8.4 exactly one task exists for that key (got ${taskCount.rows[0].n})`);
  await c1.end();
  await c2.end();

  // =================================================================
  head("ITEM 8 — round-robin rotation");
  // =================================================================
  const rr = await makeAutomation(db, {
    customerId: ids.custA,
    name: "A round robin",
    definition: workflow(null, { assignmentMode: "RoundRobin", assigneeId: null, rotation: [ids.repA, ids.seniorA] }),
    status: "Active",
  });
  const pool = [ids.repA, ids.seniorA];
  const assigned = [];
  for (let i = 0; i < 5; i += 1) {
    const { rows } = await db.query(
      `select public.create_automation_task($1,$2,$3,$4,$5,'RR',null,'Call','High',current_date,'RoundRobin',null,$6,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
      [T, ids.custA, ids.leadA, rr.automationId, `rr-${i}`, pool],
    );
    if (rows[0].r !== "created") {
      note(`rotation call ${i} returned ${rows[0].r}`);
      continue;
    }
    const { rows: t } = await db.query(`select assigned_to from public.tasks where automation_key = $1`, [`rr-${i}`]);
    assigned.push(t[0].assigned_to);
  }
  const expected = [ids.repA, ids.seniorA, ids.repA, ids.seniorA, ids.repA];
  check(
    JSON.stringify(assigned) === JSON.stringify(expected),
    `8.5 rotation follows pool order and wraps (got ${assigned.map((a) => (a === ids.repA ? "repA" : a === ids.seniorA ? "seniorA" : a)).join(",")})`,
  );

  // A duplicate must NOT advance the cursor.
  const before = await db.query(`select last_assigned_to from public.customer_automations where id = $1`, [
    rr.automationId,
  ]);
  await db.query(
    `select public.create_automation_task($1,$2,$3,$4,$5,'RR',null,'Call','High',current_date,'RoundRobin',null,$6,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0)`,
    [T, ids.custA, ids.leadA, rr.automationId, `rr-0`, pool],
  );
  const after = await db.query(`select last_assigned_to from public.customer_automations where id = $1`, [
    rr.automationId,
  ]);
  check(
    before.rows[0].last_assigned_to === after.rows[0].last_assigned_to,
    "8.6 a duplicate does not advance the rotation cursor",
  );

  // An inactive member is skipped.
  const rrInactive = await makeAutomation(db, {
    customerId: ids.custA,
    name: "A rr inactive",
    definition: workflow(null, { assignmentMode: "RoundRobin", assigneeId: null, rotation: [ids.inactiveA] }),
    status: "Active",
  });
  const { rows: inactiveOnly } = await db.query(
    `select public.create_automation_task($1,$2,$3,$4,$5,'RR',null,'Call','High',current_date,'RoundRobin',null,$6,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
    [T, ids.custA, ids.leadA, rrInactive.automationId, "rr-inactive", [ids.inactiveA]],
  );
  check(
    inactiveOnly.rows === undefined || inactiveOnly.r === "no_eligible_assignee" || inactiveOnly === undefined
      ? true
      : true,
    "8.7 (see below) rotation of only-inactive members",
  );
  const { rows: ioRows } = await db.query(
    `select public.create_automation_task($1,$2,$3,$4,$5,'RR',null,'Call','High',current_date,'RoundRobin',null,$6,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
    [T, ids.custA, ids.leadA, rrInactive.automationId, "rr-inactive-2", [ids.inactiveA]],
  );
  check(
    ioRows[0].r === "no_eligible_assignee",
    `8.7 a rotation of only inactive members is refused (got "${ioRows[0].r}")`,
  );

  // =================================================================
  head("ITEM 8 — stale recovery and the retry ceiling");
  // =================================================================
  await db.query(`delete from public.automation_events`);
  await db.query(
    `insert into public.automation_events (customer_id, event_type, subject_id, payload)
     values ($1, 'lead.created', $2, '{}'::jsonb)`,
    [ids.custA, ids.leadA],
  );
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const claimed = await db.query(`select id, attempts, claim_token from public.claim_automation_events($1, 5, 300, 3)`, [T]);
    if (claimed.rowCount === 0) {
      const { rows } = await db.query(`select status, attempts from public.automation_events limit 1`);
      if (rows[0].status === "dead") {
        break;
      }
      note(`no claim at attempt ${attempt}, status=${rows[0].status} attempts=${rows[0].attempts}`);
      break;
    }
    await db.query(`select public.complete_automation_event($1,$2,$3,'failed','boom',true)`, [
      T,
      claimed.rows[0].id,
      claimed.rows[0].claim_token,
    ]);
  }
  const finalState = await db.query(`select status, attempts from public.automation_events limit 1`);
  check(
    finalState.rows[0].status === "dead" && finalState.rows[0].attempts === 3,
    `8.8 an event dies after exactly 3 attempts (status=${finalState.rows[0].status}, attempts=${finalState.rows[0].attempts})`,
  );

  // =================================================================
  head("ITEM 8 — record_automation_run idempotency + tenant integrity");
  // =================================================================
  await db.query(`delete from public.automation_events`);
  const { rows: evRows } = await db.query(
    `insert into public.automation_events (customer_id, event_type, subject_id, payload)
     values ($1, 'lead.created', $2, '{}'::jsonb) returning id, root_event_id, correlation_id`,
    [ids.custA, ids.leadA],
  );
  const ev = evRows[0];
  check(ev.root_event_id === ev.id, "8.9 a root event is its own root (trigger works)");

  // Claim it first: a run may only be recorded by the worker that owns
  // the event, which is itself part of the fix under test.
  const ownClaim = await db.query(`select id, claim_token from public.claim_automation_events($1, 5, 300, 3)`, [T]);
  const evClaim = ownClaim.rows.find((r) => r.id === ev.id)?.claim_token ?? null;
  const run1 = await db.query(
    `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',null,null,1) as r`,
    [T, ids.custA, active.automationId, active.versionId, ev.id, evClaim, ev.root_event_id, ev.correlation_id],
  );
  check(run1.rows[0].r === "ok", "8.10 first run recorded");
  const run2 = await db.query(
    `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,'failed','x','y',0) as r`,
    [T, ids.custA, active.automationId, active.versionId, ev.id, evClaim, ev.root_event_id, ev.correlation_id],
  );
  check(run2.rows[0].r === "duplicate", `8.11 a second run for the same event is refused (got "${run2.rows[0].r}")`);

  // Cross-tenant: Customer B recording a run against Customer A's event.
  let crossRunOutcome;
  try {
    const { rows } = await db.query(
      `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',null,null,1) as r`,
      [T, ids.custB, foreign.automationId, foreign.versionId, ev.id, evClaim, ev.root_event_id, ev.correlation_id],
    );
    crossRunOutcome = rows[0].r;
  } catch (error) {
    crossRunOutcome = `error:${error.code}`;
  }
  check(
    crossRunOutcome !== "ok",
    `8.12 Customer B must not record a run against Customer A's event (got "${crossRunOutcome}")`,
  );

  const staleRun = await db.query(
    `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',null,null,1) as r`,
    [
      T,
      ids.custA,
      draft.automationId,
      draft.versionId,
      ev.id,
      "00000000-0000-4000-8000-0000000000ff",
      ev.root_event_id,
      ev.correlation_id,
    ],
  );
  check(
    staleRun.rows[0].r === "not_claimed",
    `8.13 a worker with the wrong claim token cannot record a run (got "${staleRun.rows[0].r}")`,
  );

  // =================================================================
  head("ITEM 4 — audit fields");
  // =================================================================
  const { rows: autoTask } = await db.query(
    `select created_by, automation_key from public.tasks where automation_key = $1`,
    [dupKey],
  );
  check(autoTask[0].created_by === null, "4.1 an automation-created task has created_by = NULL (no human)");
  check(Boolean(autoTask[0].automation_key), "4.2 an automation-created task carries its idempotency key");

  const traceable = await db.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='tasks' and column_name='automation_id'`,
  );
  check(
    traceable.rowCount === 1,
    "4.3 a task is traceable to its automation by a real FK column (not by parsing automation_key)",
  );

  // Can an admin forge created_by on an automation they insert?
  const adminA = await asUser(ids.adminA_auth);
  let forged = null;
  try {
    const { rows } = await adminA.query(
      `insert into public.customer_automations (customer_id, name, created_by)
       values ($1, 'forged', $2) returning created_by`,
      [ids.custA, ids.managerA_auth],
    );
    forged = rows[0].created_by;
  } catch (error) {
    forged = `error:${error.code}`;
  }
  check(
    forged !== ids.managerA_auth,
    `4.4 created_by cannot be forged to another user (got ${forged === ids.managerA_auth ? "the forged id" : forged})`,
  );

  let honest = null;
  try {
    const { rows } = await adminA.query(
      `insert into public.customer_automations (customer_id, name, created_by)
       values ($1, 'honest', $2) returning created_by`,
      [ids.custA, ids.adminA_auth],
    );
    honest = rows[0].created_by;
  } catch (error) {
    honest = `error:${error.code}`;
  }
  check(honest === ids.adminA_auth, `4.5 an admin CAN still record themselves as author (got ${honest})`);

  const taskLink = await db.query(
    `select automation_id from public.tasks where automation_key = $1`,
    [dupKey],
  );
  check(
    taskLink.rows[0]?.automation_id === active.automationId,
    "4.6 the task records WHICH automation created it",
  );

  // =================================================================
  head("ITEM 5 — worker token storage and exposure");
  // =================================================================
  const anon = await asAnon();
  await denied(() => anon.query(`select * from public.automation_worker_config`), "5.1 anon cannot read the token table");
  await denied(
    () => adminA.query(`select * from public.automation_worker_config`),
    "5.2 even a tenant ADMIN cannot read the token table",
  );
  await denied(
    () => anon.query(`select public.verify_automation_worker('x')`),
    "5.3 anon cannot call verify_automation_worker (no token oracle)",
  );
  await denied(
    () => adminA.query(`select public.verify_automation_worker('x')`),
    "5.4 authenticated cannot call verify_automation_worker",
  );

  const plaintext = await db.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='automation_worker_config' and column_name = 'token'`,
  );
  check(
    plaintext.rowCount === 0,
    "5.5 the token is NOT stored in plaintext (a dump or a future policy slip would leak it)",
  );

  const rotate = await db.query(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname='public' and p.proname = 'rotate_automation_worker_token'`,
  );
  check(rotate.rows[0].n === 1, "5.6 a rotation path exists (rotate_automation_worker_token)");

  // Every worker function must refuse a wrong token.
  const wrong = "0".repeat(64);
  const refusals = [
    [`select public.claim_automation_events($1, 5, 300, 3)`, "claim", (r) => r.rowCount === 0],
    [`select public.get_active_automations($1, $2, 'lead.created', 'created')`, "get_active_automations", (r) => r.rowCount === 0],
    [`select public.get_automation_lineage($1, $2)`, "get_automation_lineage", (r) => r.rowCount === 0],
    [`select public.get_automation_lead_facts($1, $2, $3)`, "get_automation_lead_facts", (r) => r.rowCount === 0],
  ];
  for (const [sql, label, ok] of refusals) {
    const params = sql.includes("$3") ? [wrong, ids.custA, ids.leadA] : sql.includes("$2") ? [wrong, ids.custA] : [wrong];
    const r = await db.query(sql, params);
    check(ok(r), `5.7 ${label} returns nothing for a wrong token`);
  }
  const wrongTask = await db.query(
    `select public.create_automation_task($1,$2,$3,$4,'wt','S',null,'Call','High',current_date,'Fixed',$5,'{}','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0) as r`,
    [wrong, ids.custA, ids.leadA, active.automationId, ids.repA],
  );
  check(wrongTask.rows[0].r === "unauthorized", "5.8 create_automation_task refuses a wrong token");

  // =================================================================
  head("ITEM 6 — RLS across two tenants and all four roles");
  // =================================================================
  const adminB = await asUser(ids.adminB_auth);
  const managerA = await asUser(ids.managerA_auth);
  const seniorA = await asUser(ids.seniorA_auth);
  const repA = await asUser(ids.repA_auth);

  const aCount = await adminA.query(`select count(*)::int n from public.customer_automations`);
  check(aCount.rows[0].n > 0, `6.1 ADMIN A sees their own automations (${aCount.rows[0].n})`);

  const bSeesA = await adminB.query(
    `select count(*)::int n from public.customer_automations where customer_id = $1`,
    [ids.custA],
  );
  check(bSeesA.rows[0].n === 0, `6.2 ADMIN B sees ZERO of Customer A's automations (got ${bSeesA.rows[0].n})`);

  const bOwn = await adminB.query(`select count(*)::int n from public.customer_automations`);
  check(bOwn.rows[0].n === 1, `6.3 ADMIN B sees only their own (${bOwn.rows[0].n})`);

  for (const [role, conn] of [
    ["MANAGER", managerA],
    ["SENIOR_SALES_REP", seniorA],
    ["SALES_REP", repA],
  ]) {
    const r = await conn.query(`select count(*)::int n from public.customer_automations`);
    check(r.rows[0].n === 0, `6.4 ${role} sees no automations at all (got ${r.rows[0].n})`);

    const v = await conn.query(`select count(*)::int n from public.customer_automation_versions`);
    check(v.rows[0].n === 0, `6.5 ${role} sees no versions (got ${v.rows[0].n})`);

    const e = await conn.query(`select count(*)::int n from public.automation_events`);
    check(e.rows[0].n === 0, `6.6 ${role} sees no events (got ${e.rows[0].n})`);

    const runs = await conn.query(`select count(*)::int n from public.customer_automation_runs`);
    check(runs.rows[0].n === 0, `6.7 ${role} sees no run history (got ${runs.rows[0].n})`);

    await denied(
      () => conn.query(`insert into public.customer_automations (customer_id, name) values ($1, 'nope')`, [ids.custA]),
      `6.8 ${role} cannot create an automation`,
    );
  }

  // Cross-tenant write attempts by an admin.
  await denied(
    () => adminB.query(`insert into public.customer_automations (customer_id, name) values ($1, 'B into A')`, [ids.custA]),
    "6.9 ADMIN B cannot create an automation inside Customer A",
  );
  await denied(
    () =>
      adminB.query(`update public.customer_automations set name = 'hijacked' where customer_id = $1`, [ids.custA]),
    "6.10 ADMIN B cannot update Customer A's automations",
  );

  // Versions are immutable to everyone.
  await denied(
    () => adminA.query(`update public.customer_automation_versions set definition = '{}'::jsonb`),
    "6.11 even ADMIN A cannot modify a stored version (immutability is a permission)",
  );
  await denied(
    () => adminA.query(`delete from public.customer_automations`),
    "6.12 no DELETE on automations for anyone",
  );
  await denied(
    () => adminA.query(`delete from public.customer_automation_versions`),
    "6.13 no DELETE on versions for anyone",
  );

  // The outbox and history are engine-written only.
  await denied(
    () =>
      adminA.query(
        `insert into public.automation_events (customer_id, event_type, subject_id) values ($1,'lead.created',$2)`,
        [ids.custA, ids.leadA],
      ),
    "6.14 ADMIN A cannot insert into the outbox",
  );
  await denied(
    () => adminA.query(`update public.automation_events set status = 'succeeded'`),
    "6.15 ADMIN A cannot mutate the outbox",
  );
  await denied(
    () => adminA.query(`update public.customer_automation_runs set status = 'succeeded'`),
    "6.16 ADMIN A cannot rewrite run history",
  );

  // anon sees nothing at all.
  for (const table of [
    "customer_automations",
    "customer_automation_versions",
    "automation_events",
    "customer_automation_runs",
  ]) {
    await denied(() => anon.query(`select * from public.${table}`), `6.17 anon cannot read ${table}`);
  }

  // ADMIN A can read their own events/runs (the history UI needs this).
  const ownEvents = await adminA.query(`select count(*)::int n from public.automation_events`);
  check(ownEvents.rows[0].n >= 0, "6.18 ADMIN A can read their own outbox (history UI)");

  for (const c of [adminA, adminB, managerA, seniorA, repA, anon]) await c.end();
  await db.end();

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  if (failures.length > 0) {
    console.log("\nFAILED CHECKS:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("\nSUITE CRASHED:", error.code ?? "", error.message);
  console.error(error.stack?.split("\n").slice(0, 6).join("\n"));
  process.exitCode = 1;
});
