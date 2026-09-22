import { client, makeAutomation, seed, workflow } from "./seed.mjs";

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
const head = (m) => console.log(`\n=== ${m} ===`);

async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();
  const { rows: mint } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T = mint[0].t;

  // =====================================================================
  head("Task/Contact outbox triggers fire correctly, matched by trigger_event_type");
  // =====================================================================

  const taskCreatedAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "task.created listener",
    definition: workflow(ids.repA),
    status: "Active",
  });
  await db.query(`update public.customer_automation_versions set trigger_type = 'task.created', trigger_event_type = 'created' where automation_id = $1`, [
    taskCreatedAuto.automationId,
  ]);

  await db.query(`delete from public.automation_events`);

  const { rows: newTask } = await db.query(
    `insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to)
     values ($1,$2,'A real task','2026-01-01',$3) returning id`,
    [ids.custA, ids.leadA, ids.repA],
  );
  const taskId = newTask[0].id;

  const { rows: createdEvents } = await db.query(
    `select * from public.automation_events where event_type = 'task.created' and subject_id = $1`,
    [taskId],
  );
  check(createdEvents.length === 1, `1.1 a real Task INSERT produces exactly one task.created event (got ${createdEvents.length})`);
  check(createdEvents[0]?.operation === "created", `1.2 operation is 'created' (got "${createdEvents[0]?.operation}")`);
  check(createdEvents[0]?.old_values === null, "1.3 old_values is null for a created event");
  check(createdEvents[0]?.new_values?.subject === "A real task", "1.4 new_values snapshots the real row");

  await db.query(`update public.tasks set subject = 'Renamed' where id = $1`, [taskId]);
  const { rows: afterUpdateNoListener } = await db.query(
    `select * from public.automation_events where event_type = 'task.created' and subject_id = $1 and operation = 'updated'`,
    [taskId],
  );
  check(
    afterUpdateNoListener.length === 0,
    "1.5 an UPDATE produces NO event while only a Created-only automation is Active — the churn-avoidance guard applies to tasks exactly as it does to leads",
  );

  await db.query(`update public.customer_automation_versions set trigger_event_type = 'created_or_updated' where automation_id = $1`, [
    taskCreatedAuto.automationId,
  ]);
  await db.query(`update public.tasks set subject = 'Renamed again' where id = $1`, [taskId]);
  const { rows: afterUpdateWithListener } = await db.query(
    `select * from public.automation_events where event_type = 'task.created' and subject_id = $1 and operation = 'updated'`,
    [taskId],
  );
  check(afterUpdateWithListener.length === 1, "1.6 once a created_or_updated automation is Active, a real Task UPDATE produces exactly one event");
  // updated_at is expected alongside subject — tasks has its own
  // set-updated-at trigger, and changed_fields is a genuine, generic
  // diff of old vs new (see docs/automations.md's identical note for
  // leads: "including the always-present updated_at").
  check(
    (afterUpdateWithListener[0].changed_fields ?? []).sort().join(",") === "subject,updated_at",
    `1.7 changed_fields names exactly subject + updated_at (got ${JSON.stringify(afterUpdateWithListener[0].changed_fields)})`,
  );

  // Contact, mirrored.
  const contactCreatedAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "contact.created listener",
    definition: workflow(ids.repA),
    status: "Active",
  });
  await db.query(`update public.customer_automation_versions set trigger_type = 'contact.created', trigger_event_type = 'created' where automation_id = $1`, [
    contactCreatedAuto.automationId,
  ]);

  const { rows: newContact } = await db.query(
    `insert into public.contacts (customer_id, lead_id, owner_id, name) values ($1,$2,$3,'A real contact') returning id`,
    [ids.custA, ids.leadA, ids.repA],
  );
  const { rows: contactEvents } = await db.query(
    `select * from public.automation_events where event_type = 'contact.created' and subject_id = $1`,
    [newContact[0].id],
  );
  check(contactEvents.length === 1, `1.8 a real Contact INSERT produces exactly one contact.created event (got ${contactEvents.length})`);

  // Tenant isolation: Customer B has no Active task.created automation —
  // a Task insert for Customer B must produce no event at all.
  const { rows: taskB } = await db.query(
    `insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to)
     values ($1,$2,'B task','2026-01-01',$3) returning id`,
    [ids.custB, ids.leadB, ids.repB],
  );
  const { rows: crossTenantEvents } = await db.query(`select * from public.automation_events where subject_id = $1`, [taskB[0].id]);
  check(crossTenantEvents.length === 0, "1.9 Customer B's task produces no event — Customer B has no Active automation listening for it");

  // =====================================================================
  head("The lineage fix: an Update Task self-loop must be caught, not run forever");
  // =====================================================================
  //
  // Mirrors review4-loop-prevention.mjs's exact self-loop shape, applied
  // to the NEW surface this migration opened: update_task_via_automation
  // writing to the SAME task it targets, on a task.updated trigger. Before
  // 20260924120000's lineage fix, this write would produce a fresh
  // depth-0 root every time — invisible to the ancestry check — exactly
  // the bug already found and fixed once for Update Lead. This is the
  // regression test for the SAME fix applied to Task.

  const selfLoopAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "task self-loop probe",
    definition: workflow(ids.repA),
    status: "Active",
  });
  await db.query(`update public.customer_automation_versions set trigger_type = 'task.created', trigger_event_type = 'updated' where automation_id = $1`, [
    selfLoopAuto.automationId,
  ]);

  // A dedicated task, targeted via its own automation_key (the
  // node-reference targeting scheme — see 20260923120000's design note 7).
  const loopKey = "self-loop-task-key";
  const { rows: loopTaskRows } = await db.query(
    `insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to, automation_key, automation_id)
     values ($1,$2,'Loop task','2026-01-01',$3,$4,$5) returning id`,
    [ids.custA, ids.leadA, ids.repA, loopKey, selfLoopAuto.automationId],
  );
  const loopTaskId = loopTaskRows[0].id;

  await db.query(`delete from public.automation_events`);
  await db.query(`delete from public.customer_automation_runs`);

  async function driveOneEvent() {
    const claimed = await db.query(`select * from public.claim_automation_events($1, 5, 300, 3)`, [T]);
    if (claimed.rowCount === 0) return null;
    const event = claimed.rows[0];

    const lineage = await db.query(`select * from public.get_automation_lineage($1, $2)`, [T, event.root_event_id]);
    const ancestry = lineage.rows[0]?.automation_ids ?? [];

    const actives = await db.query(`select * from public.get_active_automations($1,$2,'task.created',$3)`, [
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
      if (event.depth > 3) {
        outcomes.push("stopped_depth");
        continue;
      }

      // The action: rename the task it targets — its own write, if
      // lineage is NOT propagated, would look like a fresh human edit
      // and re-fire the trigger as an unrelated depth-0 root forever.
      const result = await db.query(
        `select public.update_task_via_automation($1,$2,$3,$4,$5,'still looping',null,null,null,null,null,false,'Fixed',null,'{}',$6,$7,$8) as r`,
        [T, event.customer_id, loopKey, automation.automation_id, `loop-${event.id}-${automation.automation_id}`, event.root_event_id, event.correlation_id, event.depth],
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
  await db.query(`update public.tasks set subject = 'kick off the loop' where id = $1`, [loopTaskId]);

  const rounds = [];
  for (let i = 0; i < 8; i++) {
    const r = await driveOneEvent();
    if (!r) break;
    rounds.push(r);
  }

  check(rounds.length > 0, "2.1 at least one round ran");
  check(rounds.length < 8, `2.2 the self-loop terminated on its own, not by exhausting the bounded 8-round test loop (ran ${rounds.length} rounds)`);

  const roots = new Set(rounds.map((r) => r.event.root_event_id));
  check(roots.size === 1, `2.3 every event in the chain shares ONE root_event_id (got ${roots.size} distinct roots) — lineage was propagated, not reset`);

  const depths = rounds.map((r) => r.event.depth);
  check(
    depths.every((d, i) => i === 0 || d === depths[i - 1] + 1),
    `2.4 depth increments by exactly one each round (got ${JSON.stringify(depths)})`,
  );

  const stoppedRound = rounds.find((r) => r.outcomes.includes("stopped_ancestry"));
  check(Boolean(stoppedRound), "2.5 the ancestry safeguard fired and stopped the loop (not the depth or action-budget safeguard reaching its own limit first)");

  const { rows: finalTask } = await db.query(`select subject from public.tasks where id = $1`, [loopTaskId]);
  check(finalTask[0].subject === "still looping", "2.6 the task's own write DID land (this is a real loop, not a no-op) before being stopped");

  // =====================================================================
  head("Deactivate Lead — one-way, tenant-scoped, idempotent, never a real DELETE");
  // =====================================================================

  const lifecycleAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "deactivate-lead probe",
    definition: workflow(ids.repA),
    status: "Active",
  });
  const draftAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "deactivate-lead draft",
    definition: workflow(ids.repA),
    status: "Draft",
    setActive: false,
  });

  async function deactivateLead(args) {
    const { rows } = await db.query(`select public.deactivate_lead_via_automation($1,$2,$3,$4,$5,$6,$7,$8) as r`, args);
    return rows[0].r;
  }
  const LINEAGE = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", 0];

  check(
    (await deactivateLead(["wrong", ids.custA, ids.leadA, lifecycleAuto.automationId, "dl1", ...LINEAGE])) === "unauthorized",
    "3.1 wrong token -> unauthorized",
  );
  check(
    (await deactivateLead([T, ids.custA, ids.leadA, lifecycleAuto.automationId, "", ...LINEAGE])) === "missing_idempotency_key",
    "3.2 blank automation_key -> missing_idempotency_key",
  );
  check(
    (await deactivateLead([T, ids.custA, ids.leadA, draftAuto.automationId, "dl2", ...LINEAGE])) === "automation_not_active",
    "3.3 a Draft automation -> automation_not_active",
  );
  // The automation-tenancy check (step 2) runs before the lead-tenancy
  // check (step 3) — Customer B's own p_customer_id means Customer A's
  // automationId is not found for THAT tenant at all, so this is refused
  // as invalid_automation, not invalid_lead. Either status is a correct
  // refusal; asserting the specific one documents which check actually
  // fires first.
  check(
    (await deactivateLead([T, ids.custB, ids.leadA, lifecycleAuto.automationId, "dl3", ...LINEAGE])) === "invalid_automation",
    "3.4 Customer B calling with Customer A's automation id -> invalid_automation (cross-tenant refused)",
  );
  check(
    (await deactivateLead([T, ids.custA, "00000000-0000-0000-0000-000000000000", lifecycleAuto.automationId, "dl4", ...LINEAGE])) === "invalid_lead",
    "3.5 a nonexistent lead -> invalid_lead",
  );
  check(
    (await deactivateLead([T, ids.custA, ids.leadB, lifecycleAuto.automationId, "dl4b", ...LINEAGE])) === "invalid_lead",
    "3.5b Customer A's own automation, but Customer B's lead id -> invalid_lead (real cross-tenant lead access refused)",
  );

  const before = await db.query(`select status from public.leads where id = $1`, [ids.leadA]);
  check(before.rows[0].status === "Active", "3.6 baseline: the lead starts Active");

  const first = await deactivateLead([T, ids.custA, ids.leadA, lifecycleAuto.automationId, "dl-real", ...LINEAGE]);
  check(first === "deactivated", `3.7 a valid call deactivates the lead (got "${first}")`);

  const after = await db.query(`select status from public.leads where id = $1`, [ids.leadA]);
  check(after.rows[0].status === "Inactive", "3.8 the lead's status is now Inactive");

  const retry = await deactivateLead([T, ids.custA, ids.leadA, lifecycleAuto.automationId, "dl-real", ...LINEAGE]);
  check(retry === "duplicate", `3.9 retrying the same automation_key -> duplicate, not re-run (got "${retry}")`);

  // One-way: deactivating an already-Inactive lead via a NEW key still
  // succeeds as an idempotent no-op-on-state (the row already reads
  // Inactive), never reactivates, and there is no function anywhere in
  // this schema that could set it back to Active from the automation path.
  const second = await deactivateLead([T, ids.custA, ids.leadA, lifecycleAuto.automationId, "dl-second-key", ...LINEAGE]);
  check(second === "deactivated", `3.10 deactivating an already-Inactive lead under a NEW key still reports success, not an error (got "${second}")`);
  const stillInactive = await db.query(`select status from public.leads where id = $1`, [ids.leadA]);
  check(stillInactive.rows[0].status === "Inactive", "3.11 still Inactive — no reactivation path exists");

  const grants = await db.query(`
    select grantee from information_schema.role_routine_grants
     where routine_name = 'deactivate_lead_via_automation' and grantee in ('anon','authenticated')
  `);
  check(grants.rowCount === 2, `3.12 deactivate_lead_via_automation is callable only via the token-gated path granted to anon/authenticated (got ${grants.rowCount} grants)`);

  await db.end();

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
