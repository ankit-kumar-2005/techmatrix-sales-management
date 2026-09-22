import { client, seed } from "./seed.mjs";

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
  return Boolean(ok);
}
function head(m) {
  console.log(`\n=== ${m} ===`);
}
function note(m) {
  console.log(`        ${m}`);
}

const EVENT_BATCH_SIZE = 25;
const PROCESSING_TIMEOUT_SECONDS = 300;
const MAX_RETRIES_PER_EVENT = 3;

function buildAutomationKey({ automationId, version, eventId, nodeId }) {
  return `a:${automationId}:v${version}:e:${eventId}:n:${nodeId}`;
}

async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();

  const { rows: mint } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T = mint[0].t;

  // =====================================================================
  head("PHASE 0.2 — versioning: does a save sequence really produce 1, 2, 3...?");
  // =====================================================================
  {
    const { rows: a } = await db.query(
      `insert into public.customer_automations (customer_id, name, status, origin, created_by)
       values ($1, 'Versioning check', 'Draft', 'Manual', null) returning id`,
      [ids.custA],
    );
    const automationId = a[0].id;

    async function saveOnce(def) {
      // Mirrors saveAutomationAction's exact pattern: read the current
      // max version for this automation, insert version = max + 1.
      const { rows: latest } = await db.query(
        `select version from public.customer_automation_versions
          where customer_id = $1 and automation_id = $2
          order by version desc limit 1`,
        [ids.custA, automationId],
      );
      const nextVersion = (latest[0]?.version ?? 0) + 1;
      await db.query(
        `insert into public.customer_automation_versions
           (customer_id, automation_id, version, trigger_type, definition, created_by)
         values ($1, $2, $3, 'lead.created', $4, null)`,
        [ids.custA, automationId, nextVersion, JSON.stringify(def)],
      );
      return nextVersion;
    }

    const v1 = await saveOnce({ nodes: [], edges: [], n: 1 });
    check(v1 === 1, `first save of a brand-new automation produces version 1 (got ${v1})`);

    const v2 = await saveOnce({ nodes: [], edges: [], n: 2 });
    check(v2 === 2, `editing and saving again produces version 2 (got ${v2})`);

    const v3 = await saveOnce({ nodes: [], edges: [], n: 3 });
    check(v3 === 3, `a third save produces version 3 (got ${v3})`);

    // Also check this holds while the automation is Active, not just Draft —
    // the spec makes no distinction, and neither does the actual insert.
    // customer_automations_active_needs_version requires active_version_id
    // to be set in the SAME statement as status = 'Active', so point it at
    // the version just inserted (v3) first.
    const { rows: v3row } = await db.query(
      `select id from public.customer_automation_versions where automation_id = $1 and version = $2`,
      [automationId, v3],
    );
    await db.query(`update public.customer_automations set status = 'Active', active_version_id = $1 where id = $2`, [
      v3row[0].id,
      automationId,
    ]);
    const v4 = await saveOnce({ nodes: [], edges: [], n: 4 });
    check(v4 === 4, `saving an ACTIVE automation still increments to version 4, same as a Draft one (got ${v4})`);

    const { rows: allVersions } = await db.query(
      `select version from public.customer_automation_versions where automation_id = $1 order by version`,
      [automationId],
    );
    check(
      JSON.stringify(allVersions.map((r) => r.version)) === JSON.stringify([1, 2, 3, 4]),
      `stored version numbers are exactly [1,2,3,4], no gaps or duplicates`,
    );
  }

  // =====================================================================
  head("PHASE 0.3 — bulk-load: ~100 real ingest_lead() pushes, then a real drain");
  // =====================================================================

  // A real, Active lead-capture integration for Customer A — the exact
  // row ingest_lead() looks up by webhook_token.
  const webhookToken = "b".repeat(64);
  await db.query(
    `insert into public.customer_integrations (customer_id, source, webhook_token, status)
     values ($1, 'IndiaMART', $2, 'Active')`,
    [ids.custA, webhookToken],
  );

  // A real Active automation: lead.created (any source) -> task.create,
  // Fixed assignee — the same minimal shape test/db/seed.mjs's own
  // workflow() helper builds, created directly here so this file has no
  // dependency on makeAutomation's default (setActive=true) behavior.
  const { rows: autoRows } = await db.query(
    `insert into public.customer_automations (customer_id, name, status, origin, created_by)
     values ($1, 'Bulk load workflow', 'Draft', 'Manual', null) returning id`,
    [ids.custA],
  );
  const automationId = autoRows[0].id;
  const definition = {
    nodes: [
      { id: "t1", kind: "trigger", type: "lead.created", position: { x: 0, y: 0 }, config: { sources: [], eventType: "created" } },
      {
        id: "a1",
        kind: "action",
        type: "task.create",
        position: { x: 300, y: 0 },
        config: {
          subject: "Follow up with {{lead.company}}",
          description: null,
          type: "Call",
          priority: "High",
          dueInDays: 1,
          assignmentMode: "Fixed",
          assigneeId: ids.repA,
          rotation: [],
        },
      },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
  const { rows: verRows } = await db.query(
    `insert into public.customer_automation_versions
       (customer_id, automation_id, version, trigger_type, trigger_event_type, definition, created_by)
     values ($1, $2, 1, 'lead.created', 'created', $3, null) returning id`,
    [ids.custA, automationId, JSON.stringify(definition)],
  );
  const versionId = verRows[0].id;
  await db.query(`update public.customer_automations set status = 'Active', active_version_id = $1 where id = $2`, [
    versionId,
    automationId,
  ]);

  const LEAD_COUNT = 100;
  const CONCURRENCY = 10;

  // A pool of concurrent connections — simulating genuinely concurrent
  // webhook pushes arriving in a burst, the way a real bulk IndiaMART
  // export might, rather than one connection serialising every insert.
  const pool = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const c = client();
    await c.connect();
    pool.push(c);
  }

  const ingestStart = process.hrtime.bigint();
  const ingestResults = await Promise.all(
    Array.from({ length: LEAD_COUNT }, (_, i) => {
      const conn = pool[i % CONCURRENCY];
      const externalId = `UNIQUE_QUERY_ID_${i}_${Math.random().toString(36).slice(2)}`;
      return conn
        .query(`select public.ingest_lead($1,$2,$3,$4,$5,$6,$7,$8,$9) as r`, [
          webhookToken,
          "IndiaMART",
          externalId,
          `Contact ${i}`,
          `Company ${i}`,
          `lead${i}@example.test`,
          "9999999999",
          "Some address",
          null,
        ])
        .then((res) => res.rows[0].r);
    }),
  );
  const ingestMs = Number(process.hrtime.bigint() - ingestStart) / 1e6;

  for (const c of pool) await c.end();

  const createdCount = ingestResults.filter((r) => r === "created").length;
  check(createdCount === LEAD_COUNT, `all ${LEAD_COUNT} concurrent ingest_lead() pushes returned "created" (got ${createdCount})`);
  note(`ingest of ${LEAD_COUNT} leads across ${CONCURRENCY} concurrent connections: ${ingestMs.toFixed(0)}ms wall-clock`);

  // seed() itself already creates 2 leads for custA (leadA, leadA2) —
  // scoped to this test's own rows by company name so that fixture
  // doesn't skew the count.
  const { rows: leadCountRows } = await db.query(
    `select count(*)::int as n from public.leads where customer_id = $1 and company like 'Company %'`,
    [ids.custA],
  );
  check(leadCountRows[0].n === LEAD_COUNT, `exactly ${LEAD_COUNT} lead rows exist for this test (got ${leadCountRows[0].n}) — no lost or duplicated leads`);

  const { rows: eventCountRows } = await db.query(
    `select count(*)::int as n from public.automation_events where customer_id = $1 and event_type = 'lead.created'`,
    [ids.custA],
  );
  check(
    eventCountRows[0].n === LEAD_COUNT,
    `exactly ${LEAD_COUNT} automation_events rows were produced (got ${eventCountRows[0].n}) — one push, one event, every time`,
  );

  const { rows: distinctSubjects } = await db.query(
    `select count(distinct subject_id)::int as n from public.automation_events where customer_id = $1 and event_type = 'lead.created'`,
    [ids.custA],
  );
  check(distinctSubjects[0].n === LEAD_COUNT, `all ${LEAD_COUNT} event subject_ids are distinct — no duplicate events for one lead`);

  // ---- Drain the queue: mirror engine.ts's own per-event logic exactly,
  // using several concurrent "worker" connections to mirror the real
  // after()-drain-plus-cron overlap this app actually has. ----
  const workerCount = 4;
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    const c = client();
    await c.connect();
    workers.push(c);
  }

  async function drainOnce(worker) {
    const { rows: claimed } = await worker.query(
      `select * from public.claim_automation_events($1,$2,$3,$4)`,
      [T, EVENT_BATCH_SIZE, PROCESSING_TIMEOUT_SECONDS, MAX_RETRIES_PER_EVENT],
    );
    for (const event of claimed) {
      const { rows: autos } = await worker.query(
        `select * from public.get_active_automations($1,$2,$3,$4)`,
        [T, event.customer_id, event.event_type, event.operation],
      );
      let anyFailure = false;
      for (const automation of autos) {
        const key = buildAutomationKey({
          automationId: automation.automation_id,
          version: automation.version,
          eventId: event.id,
          nodeId: "a1",
        });
        const { rows: taskResult } = await worker.query(
          `select public.create_automation_task($1,$2,$3,$4,$5,$6,$7,$8,$9,current_date,$10,$11,$12,$13,$14,$15) as r`,
          [
            T,
            event.customer_id,
            event.subject_id,
            automation.automation_id,
            key,
            "Follow up",
            null,
            "Call",
            "High",
            "Fixed",
            ids.repA,
            [],
            event.root_event_id,
            event.correlation_id,
            event.depth,
          ],
        );
        const outcome = taskResult[0].r;
        if (outcome !== "created" && outcome !== "duplicate") anyFailure = true;
        await worker.query(
          `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r`,
          [
            T,
            event.customer_id,
            automation.automation_id,
            automation.version_id,
            event.id,
            event.claim_token,
            event.root_event_id,
            event.correlation_id,
            outcome === "created" || outcome === "duplicate" ? "succeeded" : "failed",
            null,
            outcome === "created" || outcome === "duplicate" ? null : outcome,
            outcome === "created" ? 1 : 0,
          ],
        );
      }
      await worker.query(`select public.complete_automation_event($1,$2,$3,$4,$5,$6) as r`, [
        T,
        event.id,
        event.claim_token,
        anyFailure ? "failed" : "succeeded",
        anyFailure ? "at least one automation failed" : null,
        false,
      ]);
    }
    return claimed.length;
  }

  const drainStart = process.hrtime.bigint();
  let totalClaimed = 0;
  // Concurrent workers, each looping until the queue is empty — mirrors
  // several overlapping cron/after() drains against the same backlog.
  await Promise.all(
    workers.map(async (worker) => {
      for (;;) {
        const n = await drainOnce(worker);
        totalClaimed += n;
        if (n === 0) break;
      }
    }),
  );
  const drainMs = Number(process.hrtime.bigint() - drainStart) / 1e6;
  for (const w of workers) await w.end();

  note(`drain: ${totalClaimed} events claimed across ${workerCount} concurrent workers in ${drainMs.toFixed(0)}ms wall-clock`);
  note(`total (ingest + drain) wall-clock: ${(ingestMs + drainMs).toFixed(0)}ms for ${LEAD_COUNT} leads`);

  const { rows: taskCountRows } = await db.query(
    `select count(*)::int as n from public.tasks where customer_id = $1 and automation_id = $2`,
    [ids.custA, automationId],
  );
  check(taskCountRows[0].n === LEAD_COUNT, `exactly ${LEAD_COUNT} tasks were created (got ${taskCountRows[0].n}) — zero lost, zero duplicated`);

  const { rows: statusRows } = await db.query(
    `select status, count(*)::int as n from public.automation_events where customer_id = $1 and event_type = 'lead.created' group by status`,
    [ids.custA],
  );
  note(`final event status breakdown: ${JSON.stringify(statusRows)}`);
  check(
    statusRows.length === 1 && statusRows[0].status === "succeeded" && statusRows[0].n === LEAD_COUNT,
    `every one of the ${LEAD_COUNT} events ended in 'succeeded' — none left pending/processing/dead`,
  );

  const { rows: runCountRows } = await db.query(
    `select count(*)::int as n from public.customer_automation_runs where customer_id = $1 and automation_id = $2`,
    [ids.custA, automationId],
  );
  check(runCountRows[0].n === LEAD_COUNT, `exactly ${LEAD_COUNT} run-history rows recorded (got ${runCountRows[0].n}) — no duplicate or missing run records`);

  await db.end();

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
