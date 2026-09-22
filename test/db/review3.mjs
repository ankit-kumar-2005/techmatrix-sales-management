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

/**
 * Phase 3/6 — record-triggered events (Created / Updated / Created-or-
 * Updated), the dynamic old/new snapshot, and the Update Lead privileged
 * write. Complements review.mjs/review2.mjs/exploit-claim-null.mjs,
 * which cover everything from 20260921120000 and are re-run in full
 * alongside this file, not replaced by it.
 */
async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();
  const { rows: mint } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T = mint[0].t;

  // =================================================================
  head("The outbox trigger on a real UPDATE");
  // =================================================================
  const createdOnly = await makeAutomation(db, {
    customerId: ids.custA,
    name: "Created only",
    definition: workflow(ids.repA),
    status: "Active",
  });
  await db.query(`update public.customer_automation_versions set trigger_event_type = 'created' where automation_id = $1`, [
    createdOnly.automationId,
  ]);

  await db.query(`delete from public.automation_events`);
  const { rows: leadRows } = await db.query(
    `insert into public.leads (customer_id, company, contact_name, email, stage_id, source, status, next_step, deal_value)
     values ($1,'Snapshot Co','Contact X','x@example.test',$2,'IndiaMART','Active','Old step', 1000)
     returning id`,
    [ids.custA, ids.stageA],
  );
  const leadId = leadRows[0].id;

  const afterInsert = await db.query(`select count(*)::int n from public.automation_events`);
  check(afterInsert.rows[0].n === 1, `1.1 a real INSERT enqueues exactly one event (got ${afterInsert.rows[0].n})`);

  await db.query(`delete from public.automation_events`);

  await db.query(`update public.leads set company = $2, deal_value = 2000, next_step = 'New step' where id = $1`, [
    leadId,
    "Snapshot Co Updated",
  ]);

  const churnGuard = await db.query(`select count(*)::int n from public.automation_events`);
  check(
    churnGuard.rows[0].n === 0,
    `1.2 a tenant with only a Created-only Active automation gets NO event on an UPDATE (got ${churnGuard.rows[0].n})`,
  );

  // Now make it created_or_updated and repeat.
  await db.query(`update public.customer_automation_versions set trigger_event_type = 'created_or_updated' where automation_id = $1`, [
    createdOnly.automationId,
  ]);
  await db.query(`update public.leads set deal_value = 3000 where id = $1`, [leadId]);

  const ev = await db.query(
    `select * from public.automation_events order by created_at desc limit 1`,
  );
  check(ev.rowCount === 1, "1.3 a created_or_updated automation DOES enqueue on an UPDATE");
  const row = ev.rows[0];
  check(row.operation === "updated", `1.4 operation is "updated" (got "${row.operation}")`);
  check(row.old_values !== null, "1.5 old_values is captured for an update");
  check(row.new_values !== null, "1.6 new_values is captured for an update");
  check(!("customer_id" in row.old_values) && !("id" in row.old_values), "1.7 old_values strips customer_id/id");
  check(!("customer_id" in row.new_values) && !("id" in row.new_values), "1.8 new_values strips customer_id/id");
  check(row.new_values.deal_value === "3000" || row.new_values.deal_value === 3000, `1.9 new_values.deal_value reflects the update (got ${row.new_values.deal_value})`);
  check(row.old_values.deal_value === "2000" || row.old_values.deal_value === 2000, `1.10 old_values.deal_value is the PRIOR value (got ${row.old_values.deal_value})`);

  check(
    Array.isArray(row.changed_fields) && row.changed_fields.includes("deal_value"),
    `1.11 changed_fields includes the changed column (got ${JSON.stringify(row.changed_fields)})`,
  );
  check(
    !row.changed_fields.includes("company"),
    `1.12 changed_fields does NOT include a column that did not change (got ${JSON.stringify(row.changed_fields)})`,
  );
  // updated_at is bumped by leads_set_updated_at on every UPDATE, so a
  // correct diff always includes it too — this is not a bug in the
  // generic diff, it is the generic diff being generic.
  check(row.changed_fields.includes("updated_at"), "1.13 changed_fields includes updated_at (bumped by every UPDATE)");

  // =================================================================
  head("eventType matching end to end (via get_active_automations)");
  // =================================================================
  const updatedOnly = await makeAutomation(db, {
    customerId: ids.custA,
    name: "Updated only",
    definition: workflow(ids.repA),
    status: "Active",
  });
  await db.query(`update public.customer_automation_versions set trigger_event_type = 'updated' where automation_id = $1`, [
    updatedOnly.automationId,
  ]);

  const matchesCreated = await db.query(`select automation_id from public.get_active_automations($1,$2,'lead.created','created')`, [
    T,
    ids.custA,
  ]);
  const matchesUpdated = await db.query(`select automation_id from public.get_active_automations($1,$2,'lead.created','updated')`, [
    T,
    ids.custA,
  ]);

  const createdIds = matchesCreated.rows.map((r) => r.automation_id);
  const updatedIds = matchesUpdated.rows.map((r) => r.automation_id);

  check(createdIds.includes(createdOnly.automationId), "2.1 a created_or_updated automation matches a 'created' event");
  check(updatedIds.includes(createdOnly.automationId), "2.2 a created_or_updated automation matches an 'updated' event");
  check(!createdIds.includes(updatedOnly.automationId), "2.3 an updated-only automation does NOT match a 'created' event");
  check(updatedIds.includes(updatedOnly.automationId), "2.4 an updated-only automation matches an 'updated' event");

  // =================================================================
  head("update_lead_via_automation — allowlist, tenancy, idempotency");
  // =================================================================
  const updAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "Update lead auto",
    definition: workflow(ids.repA),
    status: "Active",
  });
  const foreignUpdAuto = await makeAutomation(db, {
    customerId: ids.custB,
    name: "Update lead auto B",
    definition: workflow(ids.repB),
    status: "Active",
  });

  const before = await db.query(`select * from public.leads where id = $1`, [leadId]);
  const beforeRow = before.rows[0];

  const callUpdate = async (overrides = {}) => {
    const args = {
      token: T,
      customer: ids.custA,
      lead: leadId,
      automation: updAuto.automationId,
      key: `upd-${Math.random().toString(36).slice(2)}`,
      nextStep: "Updated next step",
      dealValue: 9999,
      status: "Inactive",
      assignOwner: false,
      assignmentMode: "Fixed",
      fixedAssignee: null,
      pool: [],
      ...overrides,
    };
    const { rows } = await db.query(
      `select public.update_lead_via_automation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) as r`,
      [
        args.token,
        args.customer,
        args.lead,
        args.automation,
        args.key,
        args.nextStep,
        args.dealValue,
        args.status,
        args.assignOwner,
        args.assignmentMode,
        args.fixedAssignee,
        args.pool,
        // Lineage — not under test in this block (see the dedicated
        // "lineage propagation" section below), so a fixed synthetic
        // root at depth 0 is enough to make the call structurally valid.
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        0,
      ],
    );
    return rows[0].r;
  };

  check((await callUpdate()) === "updated", "3.0 baseline: a valid call updates the lead");

  const afterUpdate = await db.query(`select * from public.leads where id = $1`, [leadId]);
  const afterRow = afterUpdate.rows[0];
  check(afterRow.next_step === "Updated next step", "3.1 next_step was updated");
  check(Number(afterRow.deal_value) === 9999, `3.2 deal_value was updated (got ${afterRow.deal_value})`);
  check(afterRow.status === "Inactive", "3.3 status was updated");

  check(afterRow.company === beforeRow.company, "3.4 company is UNCHANGED — not in the allowlist");
  check(afterRow.contact_name === beforeRow.contact_name, "3.5 contact_name is UNCHANGED — not in the allowlist");
  check(afterRow.email === beforeRow.email, "3.6 email is UNCHANGED — not in the allowlist");
  check(afterRow.source === beforeRow.source, "3.7 source is UNCHANGED — not in the allowlist");
  check(afterRow.stage_id === beforeRow.stage_id, "3.8 stage_id is UNCHANGED — no parameter can reach it");
  check(afterRow.customer_id === beforeRow.customer_id, "3.9 customer_id is UNCHANGED");

  const crossTenantUpdate = await callUpdate({ automation: foreignUpdAuto.automationId });
  check(
    crossTenantUpdate !== "updated",
    `3.10 Customer B's automation_id must NOT update Customer A's lead (got "${crossTenantUpdate}")`,
  );

  const crossLeadUpdate = await db.query(
    `select public.update_lead_via_automation($1,$2,$3,$4,'cross-lead','x',null,null,false,'Fixed',null,'{}',$5,$6,0) as r`,
    [T, ids.custA, ids.leadB, updAuto.automationId, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
  );
  check(crossLeadUpdate.rows[0].r === "invalid_lead", `3.11 Customer B's lead is rejected (got "${crossLeadUpdate.rows[0].r}")`);

  const ghostAutomation = await callUpdate({ automation: "00000000-0000-4000-8000-000000000000" });
  check(ghostAutomation === "invalid_automation", `3.12 a nonexistent automation_id is rejected (got "${ghostAutomation}")`);

  const draftAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "Draft update",
    definition: workflow(ids.repA),
    status: "Draft",
    setActive: false,
  });
  const draftUpdate = await callUpdate({ automation: draftAuto.automationId });
  check(draftUpdate === "automation_not_active", `3.13 a Draft automation cannot update a lead (got "${draftUpdate}")`);

  const negativeDealValue = await callUpdate({ dealValue: -1 });
  check(negativeDealValue === "invalid_deal_value", `3.14 a negative deal value is rejected (got "${negativeDealValue}")`);

  const badStatus = await callUpdate({ status: "Deleted" });
  check(badStatus === "invalid_status", `3.15 an invalid status is rejected (got "${badStatus}")`);

  // Idempotency.
  const dupKey = `upd-dup-${Math.random().toString(36).slice(2)}`;
  const first = await callUpdate({ key: dupKey, nextStep: "First value" });
  const second = await callUpdate({ key: dupKey, nextStep: "Second value — should never apply" });
  check(first === "updated", "3.16 first call with a fresh key succeeds");
  check(second === "duplicate", `3.17 a second call with the SAME key is refused (got "${second}")`);
  const afterDup = await db.query(`select next_step from public.leads where id = $1`, [leadId]);
  check(afterDup.rows[0].next_step === "First value", "3.18 the duplicate call's value never applied");

  const ledger = await db.query(`select count(*)::int n from public.automation_action_executions where automation_key = $1`, [
    dupKey,
  ]);
  check(ledger.rows[0].n === 1, `3.19 exactly one ledger row exists for that key (got ${ledger.rows[0].n})`);

  // "Untouched" fields.
  await db.query(`update public.leads set next_step = 'Sentinel', deal_value = 4242, status = 'Active' where id = $1`, [leadId]);
  const untouchedKey = `upd-notouch-${Math.random().toString(36).slice(2)}`;
  await callUpdate({ key: untouchedKey, nextStep: null, dealValue: null, status: null });
  const stillSentinel = await db.query(`select next_step, deal_value, status from public.leads where id = $1`, [leadId]);
  check(stillSentinel.rows[0].next_step === "Sentinel", "3.20 a NULL next_step leaves it untouched");
  check(Number(stillSentinel.rows[0].deal_value) === 4242, "3.21 a NULL deal_value leaves it untouched");
  check(stillSentinel.rows[0].status === "Active", "3.22 a NULL status leaves it untouched");

  // =================================================================
  head("update_lead_via_automation — round-robin, shared cursor with create_automation_task");
  // =================================================================
  const rrAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "RR shared cursor",
    definition: workflow(null),
    status: "Active",
  });
  const pool = [ids.repA, ids.seniorA];

  // First pick via create_automation_task.
  await db.query(
    `select public.create_automation_task($1,$2,$3,$4,'rr-shared-1','S',null,'Call','High',current_date,'RoundRobin',null,$5,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',0)`,
    [T, ids.custA, leadId, rrAuto.automationId, pool],
  );
  const afterTask = await db.query(`select assigned_to from public.tasks where automation_key = 'rr-shared-1'`);
  const firstPick = afterTask.rows[0].assigned_to;

  // Second pick via update_lead_via_automation on the SAME automation.
  await db.query(
    `select public.update_lead_via_automation($1,$2,$3,$4,'rr-shared-2',null,null,null,true,'RoundRobin',null,$5,$6,$7,0)`,
    [T, ids.custA, leadId, rrAuto.automationId, pool, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
  );
  const afterSecond = await db.query(`select owner_id from public.leads where id = $1`, [leadId]);
  const secondPick = afterSecond.rows[0].owner_id;

  check(firstPick !== secondPick, "4.1 the rotation cursor is SHARED — the second pick is the other person, not a repeat");
  check([ids.repA, ids.seniorA].includes(firstPick), "4.2 the first pick is from the configured pool");
  check([ids.repA, ids.seniorA].includes(secondPick), "4.3 the second pick is from the configured pool");

  // =================================================================
  head("protect_lead_owner_id_change — the fix does not weaken it for anyone else");
  // =================================================================
  // A plain, no-session UPDATE (no worker token involved at all, and
  // critically no set_config call) must still be refused exactly as
  // before update_lead_via_automation existed.
  //
  // The target value must genuinely DIFFER from the lead's current
  // owner_id — `new.owner_id is distinct from old.owner_id` is false,
  // and the trigger's whole check is skipped, for a same-value write.
  // secondPick (the round-robin result just above) is whichever of the
  // two pool members it landed on, so the other one is guaranteed to be
  // an actual change.
  const bareTarget = secondPick === ids.repA ? ids.seniorA : ids.repA;
  const bareAttempt = await db
    .query(`update public.leads set owner_id = $2 where id = $1`, [leadId, bareTarget])
    .then(() => "allowed")
    .catch((e) => (e.message.includes("Only an admin") ? "refused" : `error:${e.code}`));
  check(bareAttempt === "refused", `5.1 a bare no-session UPDATE to owner_id is still refused (got "${bareAttempt}")`);

  // owner_id is still `secondPick` — the bare attempt above errored, so
  // it never applied. bareTarget is guaranteed different from that.
  const adminA = await asUser(ids.adminA_auth);
  const adminChanges = await adminA
    .query(`update public.leads set owner_id = $2 where id = $1 returning owner_id`, [leadId, bareTarget])
    .then((r) => r.rows[0]?.owner_id)
    .catch((e) => `error:${e.code}`);
  check(adminChanges === bareTarget, `5.2 a real ADMIN session can still change owner_id directly (got "${adminChanges}")`);

  // owner_id is now bareTarget — flip back to secondPick for a genuine change.
  const repA = await asUser(ids.repA_auth);
  const nonAdminAttempt = await repA
    .query(`update public.leads set owner_id = $2 where id = $1`, [leadId, secondPick])
    .then(() => "allowed")
    .catch((e) => (e.message.includes("Only an admin") ? "refused" : `error:${e.code}`));
  check(nonAdminAttempt === "refused", `5.3 a non-admin session is STILL refused (the protection is intact, not bypassed) (got "${nonAdminAttempt}")`);

  await adminA.end();
  await repA.end();
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
  console.error(e.stack?.split("\n").slice(0, 6).join("\n"));
  process.exitCode = 1;
});
