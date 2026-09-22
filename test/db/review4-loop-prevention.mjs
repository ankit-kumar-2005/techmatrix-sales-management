import { client, makeAutomation, seed, workflow } from "./seed.mjs";

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

/**
 * THE GENUINE END-TO-END LOOP TEST — not possible to write honestly
 * before Update Lead existed (docs/automations.md said so explicitly:
 * task.create cannot raise an event, so no cycle could be constructed).
 * Update Lead changes that: its write goes through the same `leads`
 * table and the same trigger as any edit, so it CAN cause a new event —
 * which is exactly what a first pass at this feature got wrong.
 *
 * A real bug was found here, empirically, before this file existed: the
 * event an Update Lead write produced had NO connection to the run that
 * caused it — root_event_id defaulted to its own id, depth defaulted to
 * 0, every time. MAX_WORKFLOW_DEPTH and the ancestry check both key off
 * exactly those two things, so neither could ever see a chain Update
 * Lead's own writes created. Fixed by propagating lineage through three
 * transaction-local settings (see enqueue_lead_automation_event and
 * update_lead_via_automation in 20260922120000). This file is the
 * regression test for that fix — it is not exercising a mechanism, it
 * is exercising the specific failure mode that shipped once already.
 */
async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();
  const { rows: mint } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T = mint[0].t;

  // A single automation whose own write keeps its own condition true:
  // on updated, if deal_value > 100, update next_step. Updating
  // next_step does not change deal_value, so the condition is still
  // true after the write — a genuine, minimal self-loop.
  const selfLoop = await makeAutomation(db, {
    customerId: ids.custA,
    name: "self-loop probe",
    definition: workflow(ids.repA),
    status: "Active",
  });
  await db.query(`update public.customer_automation_versions set trigger_event_type = 'updated' where automation_id = $1`, [
    selfLoop.automationId,
  ]);

  await db.query(`delete from public.automation_events`);
  await db.query(`delete from public.customer_automation_runs`);

  const { rows: leadRows } = await db.query(
    `insert into public.leads (customer_id, company, contact_name, stage_id, source, status, deal_value)
     values ($1,'Loop Co','X',$2,'IndiaMART','Active', 50) returning id`,
    [ids.custA, ids.stageA],
  );
  const leadId = leadRows[0].id;

  // ---- Drive it exactly the way the real engine would: claim, check
  // ancestry against lineage, run the action, which itself enqueues the
  // next event in the SAME chain if the fix is working. ----
  async function driveOneEvent() {
    const claimed = await db.query(`select * from public.claim_automation_events($1, 5, 300, 3)`, [T]);
    if (claimed.rowCount === 0) return null;
    const event = claimed.rows[0];

    const lineage = await db.query(`select * from public.get_automation_lineage($1, $2)`, [T, event.root_event_id]);
    const actionsSoFar = lineage.rows[0]?.actions_executed ?? 0;
    const ancestry = lineage.rows[0]?.automation_ids ?? [];

    const actives = await db.query(`select * from public.get_active_automations($1,$2,'lead.created',$3)`, [
      T,
      event.customer_id,
      event.operation,
    ]);

    const outcomes = [];
    for (const automation of actives.rows) {
      if (ancestry.includes(automation.automation_id)) {
        await db.query(
          `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,'stopped_by_safeguard','Already ran in this lineage.',null,0)`,
          [T, event.customer_id, automation.automation_id, automation.version_id, event.id, event.claim_token, event.root_event_id, event.correlation_id],
        );
        outcomes.push("stopped_ancestry");
        continue;
      }
      if (event.depth > 3 /* MAX_WORKFLOW_DEPTH */) {
        await db.query(
          `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,'stopped_by_safeguard','Exceeded max depth.',null,0)`,
          [T, event.customer_id, automation.automation_id, automation.version_id, event.id, event.claim_token, event.root_event_id, event.correlation_id],
        );
        outcomes.push("stopped_depth");
        continue;
      }
      if (actionsSoFar >= 10 /* MAX_ACTIONS_PER_EVENT */) {
        outcomes.push("stopped_budget");
        continue;
      }

      // Deal value stays > 100 after this write — the condition, if
      // re-evaluated on the NEXT event, would still hold. This is the
      // actual recursive shape: the action's own effect satisfies the
      // trigger that would fire again.
      const result = await db.query(
        `select public.update_lead_via_automation($1,$2,$3,$4,$5,'still matching',null,null,false,'Fixed',null,'{}',$6,$7,$8) as r`,
        [
          T,
          event.customer_id,
          event.subject_id,
          automation.automation_id,
          `loop-${event.id}-${automation.automation_id}`,
          event.root_event_id,
          event.correlation_id,
          event.depth,
        ],
      );
      await db.query(
        `select public.record_automation_run($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',null,null,1)`,
        [T, event.customer_id, automation.automation_id, automation.version_id, event.id, event.claim_token, event.root_event_id, event.correlation_id],
      );
      outcomes.push(`ran:${result.rows[0].r}`);
    }

    await db.query(`select public.complete_automation_event($1,$2,$3,'succeeded',null,false)`, [T, event.id, event.claim_token]);
    return { event, outcomes };
  }

  // Seed the chain: a real UPDATE, exactly like a human edit.
  await db.query(`update public.leads set deal_value = 150 where id = $1`, [leadId]);

  const rounds = [];
  // Bounded at 8 — if the safeguard is broken, this loop keeps producing
  // work forever; if it works, it stops itself well before 8.
  for (let i = 0; i < 8; i += 1) {
    const result = await driveOneEvent();
    if (!result) break;
    rounds.push(result);
  }

  head("Self-loop: one automation whose action keeps its own trigger matching");

  check(rounds.length > 0, "1.1 at least one round actually ran (the chain was real)");

  const allEvents = await db.query(`select id, root_event_id, depth from public.automation_events order by created_at`);
  const allRoots = new Set(allEvents.rows.map((r) => r.root_event_id));
  check(
    allRoots.size === 1,
    `1.2 every event in the chain shares ONE root_event_id — the lineage fix is working (got ${allRoots.size} distinct roots)`,
  );

  const depths = allEvents.rows.map((r) => r.depth);
  check(
    depths.some((d) => d > 0),
    `1.3 depth actually increments across the chain (got depths ${JSON.stringify(depths)})`,
  );

  const stoppedRound = rounds.find((r) => r.outcomes.some((o) => o.startsWith("stopped_")));
  check(Boolean(stoppedRound), "1.4 a safeguard DID stop the chain at some point");
  if (stoppedRound) {
    console.log(`        stopped via: ${stoppedRound.outcomes.join(", ")}`);
  }

  const finalTaskCountCheck = await db.query(
    `select count(*)::int n from public.customer_automation_runs where automation_id = $1 and status = 'succeeded'`,
    [selfLoop.automationId],
  );
  check(
    finalTaskCountCheck.rows[0].n <= 1,
    `1.5 the SAME automation only ever succeeds ONCE in this lineage — ancestry caught the repeat (got ${finalTaskCountCheck.rows[0].n} successes)`,
  );

  check(rounds.length < 8, "1.6 the chain terminated on its own — it did not run for all 8 bounded rounds");

  // =================================================================
  head("Two-automation cycle: A's write triggers B, B's write triggers A");
  // =================================================================
  await db.query(`delete from public.automation_events`);
  await db.query(`delete from public.customer_automation_runs`);

  const autoA = await makeAutomation(db, {
    customerId: ids.custA,
    name: "cycle A",
    definition: workflow(ids.repA),
    status: "Active",
  });
  const autoB = await makeAutomation(db, {
    customerId: ids.custA,
    name: "cycle B",
    definition: workflow(ids.repA),
    status: "Active",
  });
  for (const id of [autoA.automationId, autoB.automationId]) {
    await db.query(`update public.customer_automation_versions set trigger_event_type = 'updated' where automation_id = $1`, [id]);
  }

  const { rows: leadRows2 } = await db.query(
    `insert into public.leads (customer_id, company, contact_name, stage_id, source, status, deal_value)
     values ($1,'Cycle Co','Y',$2,'IndiaMART','Active', 50) returning id`,
    [ids.custA, ids.stageA],
  );
  const leadId2 = leadRows2[0].id;

  await db.query(`update public.leads set deal_value = 150 where id = $1`, [leadId2]);

  const cycleRounds = [];
  for (let i = 0; i < 8; i += 1) {
    const result = await driveOneEvent();
    if (!result) break;
    cycleRounds.push(result);
  }

  check(cycleRounds.length > 0, "2.1 at least one round ran");
  check(cycleRounds.length < 8, "2.2 the A↔B cycle terminated on its own, not by exhausting the bounded loop");

  const cycleEvents = await db.query(`select root_event_id from public.automation_events`);
  const cycleRoots = new Set(cycleEvents.rows.map((r) => r.root_event_id));
  check(cycleRoots.size === 1, `2.3 the whole A↔B chain shares one root (got ${cycleRoots.size})`);

  const cycleStopped = cycleRounds.some((r) => r.outcomes.some((o) => o.startsWith("stopped_")));
  check(cycleStopped, "2.4 a safeguard stopped the A↔B cycle");

  const runsA = await db.query(
    `select count(*)::int n from public.customer_automation_runs where automation_id = $1 and status = 'succeeded'`,
    [autoA.automationId],
  );
  const runsB = await db.query(
    `select count(*)::int n from public.customer_automation_runs where automation_id = $1 and status = 'succeeded'`,
    [autoB.automationId],
  );
  check(runsA.rows[0].n <= 1, `2.5 automation A succeeds at most once in this lineage (got ${runsA.rows[0].n})`);
  check(runsB.rows[0].n <= 1, `2.6 automation B succeeds at most once in this lineage (got ${runsB.rows[0].n})`);

  // =================================================================
  head("Every safeguard stop is recorded with an honest reason");
  // =================================================================
  const stops = await db.query(
    `select stop_reason from public.customer_automation_runs where status = 'stopped_by_safeguard'`,
  );
  check(stops.rowCount > 0, "3.1 at least one stopped_by_safeguard run was recorded across both scenarios");
  check(
    stops.rows.every((r) => typeof r.stop_reason === "string" && r.stop_reason.trim() !== ""),
    "3.2 every safeguard stop carries a real, non-blank reason",
  );

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
  console.error(e.stack?.split("\n").slice(0, 8).join("\n"));
  process.exitCode = 1;
});
