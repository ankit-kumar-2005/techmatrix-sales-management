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
 * 20260923120000_task_contact_automation_writes — Task and Contact as a
 * second and third privileged write domain, TARGETED BY A DETERMINISTIC
 * KEY (design note 7 in the migration itself — a Lead-triggered workflow
 * has no raw Task/Contact id of its own; every Update/Deactivate call is
 * given the automation_key of the Create node it references, exactly the
 * shape features/automations/lib/idempotency.ts's buildAutomationKey
 * would produce for that node). Verifies, against real PostgreSQL, every
 * property the migration review asked for: clean apply, safe backfill,
 * the five functions' token/idempotency/tenancy/eligibility/allowlist
 * behaviour, key-based targeting (including that a record with NO
 * automation_key — i.e. not created by any automation — is structurally
 * unreachable), one-way deactivation with no literal DELETE anywhere,
 * and that nothing about the existing human-facing Task/Contact RLS
 * changed.
 */
async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();
  const { rows: mint } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T = mint[0].t;

  const auto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "Task/Contact writer",
    definition: workflow(ids.repA),
    status: "Active",
  });
  const draftAuto = await makeAutomation(db, {
    customerId: ids.custA,
    name: "Still a draft",
    definition: workflow(ids.repA),
    status: "Draft",
  });
  const autoB = await makeAutomation(db, {
    customerId: ids.custB,
    name: "Customer B's own",
    definition: workflow(ids.repB),
    status: "Active",
  });

  /** A task as if a Create Task node had already run for this event,
   *  under the given target key — the shape update/deactivate can find. */
  async function makeTaskWithKey(customerId, leadId, assignedTo, targetKey, subject = "Existing task") {
    const { rows } = await db.query(
      `insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to, automation_key, automation_id)
       values ($1,$2,$3, current_date, $4, $5, $6) returning id, activation_status`,
      [customerId, leadId, subject, assignedTo, targetKey, auto.automationId],
    );
    return rows[0];
  }

  async function makeContactWithKey(customerId, leadId, ownerId, targetKey, name = "Existing Contact") {
    const { rows } = await db.query(
      `insert into public.contacts (customer_id, lead_id, owner_id, name, automation_key, automation_id)
       values ($1,$2,$3,$4,$5,$6) returning id, status`,
      [customerId, leadId, ownerId, name, targetKey, auto.automationId],
    );
    return rows[0];
  }

  // =================================================================
  head("Migration applied cleanly, and existing rows backfill correctly");
  // =================================================================
  const { rows: freshTaskRows } = await db.query(
    `insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to)
     values ($1,$2,'No-key task', current_date, $3) returning id, activation_status, automation_key`,
    [ids.custA, ids.leadA, ids.repA],
  );
  check(freshTaskRows[0].activation_status === "Active", `1.1 a task inserted with no activation_status specified defaults to Active (got ${freshTaskRows[0].activation_status})`);

  const { rows: freshContactRows } = await db.query(
    `insert into public.contacts (customer_id, lead_id, owner_id, name) values ($1,$2,$3,'No-key contact') returning id, status, automation_key`,
    [ids.custA, ids.leadA, ids.repA],
  );
  check(freshContactRows[0].status === "Active", `1.2 a contact inserted with no status specified defaults to Active (got ${freshContactRows[0].status})`);

  const columnCheck = await db.query(`
    select column_name, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'activation_status'
  `);
  check(
    columnCheck.rowCount === 1 && columnCheck.rows[0].is_nullable === "NO" && columnCheck.rows[0].column_default?.includes("Active"),
    "1.3 tasks.activation_status is NOT NULL with a real 'Active' DEFAULT at the schema level (not just app-side)",
  );

  const contactColumnCheck = await db.query(`
    select column_name, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public' and table_name = 'contacts' and column_name = 'status'
  `);
  check(
    contactColumnCheck.rowCount === 1 && contactColumnCheck.rows[0].is_nullable === "NO" && contactColumnCheck.rows[0].column_default?.includes("Active"),
    "1.4 contacts.status is NOT NULL with a real 'Active' DEFAULT at the schema level",
  );

  // =================================================================
  head("No literal DELETE anywhere — structural proof, not a claim");
  // =================================================================
  // grantee = 'postgres' (the table OWNER, i.e. the migration runner) is
  // expected and out of scope here — Postgres always gives an owner
  // every privilege implicitly, independent of any GRANT statement, and
  // this schema's whole automation feature already runs as that owner
  // (see review2.mjs's own note on least-privilege ownership being a
  // separate, known, pre-existing limitation). What this check is
  // actually verifying is narrower and more important: that no
  // API-facing role — anon, authenticated, service_role — was EVER
  // explicitly granted DELETE, which is the thing that would let a
  // session, a client, or a compromised token issue a real DELETE.
  const deleteGrants = await db.query(`
    select table_name, grantee
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name in ('tasks', 'contacts')
       and privilege_type = 'DELETE'
       and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  `);
  check(
    deleteGrants.rowCount === 0,
    `2.1 no API-facing role (anon/authenticated/service_role/PUBLIC) holds DELETE on tasks or contacts (got ${deleteGrants.rowCount})`,
  );

  // =================================================================
  head("create_automation_contact");
  // =================================================================
  // Every call appends a fixed synthetic root/correlation/depth-0 triplet
  // — lineage propagation itself is not what this file is testing (see
  // review4-loop-prevention.mjs for that); these three trailing
  // parameters exist so a write here can be traced if it re-fires
  // tasks_enqueue_automation_event/contacts_enqueue_automation_event,
  // the same fixed-uuid pattern review3.mjs already established for
  // update_lead_via_automation's identical parameters.
  const LINEAGE = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", 0];

  async function createContact(args) {
    const { rows } = await db.query(
      `select public.create_automation_contact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) as r`,
      [...args, ...LINEAGE],
    );
    return rows[0].r;
  }

  check(
    (await createContact(["wrong-token", ids.custA, ids.leadA, auto.automationId, "k1", "Priya", null, null, null, null, "Fixed", ids.repA, []])) === "unauthorized",
    "3.1 wrong token -> unauthorized",
  );
  check(
    (await createContact([T, ids.custA, ids.leadA, auto.automationId, "", "Priya", null, null, null, null, "Fixed", ids.repA, []])) === "missing_idempotency_key",
    "3.2 blank automation_key -> missing_idempotency_key",
  );

  const created = await createContact([T, ids.custA, ids.leadA, auto.automationId, "contact-key-1", "Priya Sharma", "Acme", "CTO", "priya@acme.test", "9999999999", "Fixed", ids.repA, []]);
  check(created === "created", `3.3 a valid call creates a contact (got ${created})`);

  const { rows: newContactRows } = await db.query(
    `select owner_id, name, company, status, automation_id from public.contacts where customer_id=$1 and automation_key='contact-key-1'`,
    [ids.custA],
  );
  check(newContactRows.length === 1, "3.4 exactly one row landed for the successful call");
  check(newContactRows[0].owner_id === ids.repA, "3.5 owner_id resolved to the Fixed assignee");
  check(newContactRows[0].status === "Active", "3.6 a freshly automation-created contact is Active");
  check(newContactRows[0].automation_id === auto.automationId, "3.7 automation_id is recorded");

  const dup = await createContact([T, ids.custA, ids.leadA, auto.automationId, "contact-key-1", "Someone Else", null, null, null, null, "Fixed", ids.repA, []]);
  check(dup === "duplicate", `3.8 retrying the same automation_key -> duplicate, not a second row (got ${dup})`);
  const { rows: stillOne } = await db.query(`select count(*)::int n from public.contacts where automation_key='contact-key-1'`);
  check(stillOne[0].n === 1, "3.9 the duplicate retry did not create a second row");

  check(
    (await createContact([T, ids.custA, ids.leadA, "00000000-0000-0000-0000-000000000000", "k2", "X", null, null, null, null, "Fixed", ids.repA, []])) === "invalid_automation",
    "3.10 a nonexistent automation_id -> invalid_automation",
  );
  check(
    (await createContact([T, ids.custB, ids.leadA, auto.automationId, "k3", "X", null, null, null, null, "Fixed", ids.repA, []])) === "invalid_automation",
    "3.11 customer A's automation called with customer B's id -> invalid_automation (cross-tenant refused)",
  );
  check(
    (await createContact([T, ids.custA, ids.leadA, draftAuto.automationId, "k4", "X", null, null, null, null, "Fixed", ids.repA, []])) === "automation_not_active",
    "3.12 a Draft automation -> automation_not_active",
  );
  check(
    (await createContact([T, ids.custA, "00000000-0000-0000-0000-000000000000", auto.automationId, "k5", "X", null, null, null, null, "Fixed", ids.repA, []])) === "invalid_lead",
    "3.13 a nonexistent lead -> invalid_lead",
  );
  check(
    (await createContact([T, ids.custA, ids.leadA, auto.automationId, "k6", "X", null, null, null, null, "Fixed", ids.repB, []])) === "no_eligible_assignee",
    "3.14 a Fixed assignee from a DIFFERENT tenant -> no_eligible_assignee (cross-tenant assignment refused)",
  );
  check(
    (await createContact([T, ids.custA, ids.leadA, auto.automationId, "k7", "X", null, null, null, null, "RoundRobin", null, []])) === "no_eligible_assignee",
    "3.15 RoundRobin with an empty pool -> no_eligible_assignee",
  );
  check(
    (await createContact([T, ids.custA, ids.leadA, auto.automationId, "k8", "   ", null, null, null, null, "Fixed", ids.repA, []])) === "invalid_name",
    "3.16 a blank name -> invalid_name",
  );

  // =================================================================
  head("update_task_via_automation — targeted by the Create node's own key");
  // =================================================================
  async function updateTask(args) {
    const { rows } = await db.query(
      `select public.update_task_via_automation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) as r`,
      [...args, ...LINEAGE],
    );
    return rows[0].r;
  }

  const primaryTaskKey = "create-task-node-1";
  const primaryTask = await makeTaskWithKey(ids.custA, ids.leadA, ids.repA, primaryTaskKey);

  check(
    (await updateTask(["wrong", ids.custA, primaryTaskKey, auto.automationId, "tk0", null, null, null, null, null, null, false, "Fixed", null, []])) === "unauthorized",
    "4.1 wrong token -> unauthorized",
  );
  check(
    (await updateTask([T, ids.custA, primaryTaskKey, auto.automationId, "", null, null, null, null, null, null, false, "Fixed", null, []])) === "missing_idempotency_key",
    "4.2 blank automation_key -> missing_idempotency_key",
  );

  const upd1 = await updateTask([T, ids.custA, primaryTaskKey, auto.automationId, "task-key-1", "Updated subject", null, null, null, null, "Completed", false, "Fixed", null, []]);
  check(upd1 === "updated", `4.3 a valid partial update succeeds (got ${upd1})`);

  const { rows: afterUpd1 } = await db.query(`select subject, status, activation_status, assigned_to from public.tasks where id=$1`, [primaryTask.id]);
  check(afterUpd1[0].subject === "Updated subject", "4.4 subject changed as requested");
  check(afterUpd1[0].status === "Completed", "4.5 status changed as requested");
  check(afterUpd1[0].activation_status === "Active", "4.6 activation_status untouched by an ordinary update — there is no parameter that reaches it");
  check(afterUpd1[0].assigned_to === ids.repA, "4.7 assignee untouched when p_assign_owner is false");

  const upd1Retry = await updateTask([T, ids.custA, primaryTaskKey, auto.automationId, "task-key-1", "SHOULD NOT APPLY", null, null, null, null, null, false, "Fixed", null, []]);
  check(upd1Retry === "duplicate", `4.8 retrying the same automation_key -> duplicate (got ${upd1Retry})`);
  const { rows: afterRetry } = await db.query(`select subject from public.tasks where id=$1`, [primaryTask.id]);
  check(afterRetry[0].subject === "Updated subject", "4.9 the duplicate retry made no further change");

  check(
    (await updateTask([T, ids.custB, primaryTaskKey, autoB.automationId, "task-key-2", "X", null, null, null, null, null, false, "Fixed", null, []])) === "target_not_found",
    "4.10 customer B calling with customer A's target key -> target_not_found (cross-tenant refused, not leaked as a different status)",
  );
  check(
    (await updateTask([T, ids.custA, primaryTaskKey, auto.automationId, "task-key-3", null, null, "Urgent", null, null, null, false, "Fixed", null, []])) === "invalid_priority",
    "4.11 an out-of-range priority -> invalid_priority",
  );
  check(
    (await updateTask([T, ids.custA, primaryTaskKey, auto.automationId, "task-key-4", null, null, null, null, null, "Archived", false, "Fixed", null, []])) === "invalid_status",
    "4.12 an out-of-range status -> invalid_status",
  );
  check(
    (await updateTask([T, ids.custA, "no-such-create-node-key", auto.automationId, "task-key-nf", "X", null, null, null, null, null, false, "Fixed", null, []])) === "target_not_found",
    "4.13 a target key that names no row at all (the referenced Create node never ran on this event) -> target_not_found",
  );

  const reassign = await updateTask([T, ids.custA, primaryTaskKey, auto.automationId, "task-key-5", null, null, null, null, null, null, true, "RoundRobin", null, [ids.repA]]);
  check(reassign === "updated", "4.14 RoundRobin reassignment with a valid single-person pool succeeds");
  const { rows: afterReassign } = await db.query(`select assigned_to from public.tasks where id=$1`, [primaryTask.id]);
  check(afterReassign[0].assigned_to === ids.repA, "4.15 reassigned to the (only) pool member");

  // Shared rotation cursor across DIFFERENT actions in the SAME
  // automation — two calls in a row, one via create_automation_contact
  // and one via update_task_via_automation, on the identical two-person
  // pool, must not both pick the same person.
  const pool2 = [ids.repA, ids.seniorA];
  await db.query(`update public.customer_automations set last_assigned_to = null where id = $1`, [auto.automationId]);
  const c1 = await createContact([T, ids.custA, ids.leadA, auto.automationId, "rr-key-1", "RR One", null, null, null, null, "RoundRobin", null, pool2]);
  const t1 = await updateTask([T, ids.custA, primaryTaskKey, auto.automationId, "rr-key-2", null, null, null, null, null, null, true, "RoundRobin", null, pool2]);
  check(c1 === "created" && t1 === "updated", "4.16 both round-robin calls succeeded");
  const { rows: rr1 } = await db.query(`select owner_id from public.contacts where automation_key='rr-key-1'`);
  const { rows: rr2 } = await db.query(`select assigned_to from public.tasks where id=$1`, [primaryTask.id]);
  check(
    rr1[0].owner_id !== rr2[0].assigned_to,
    `4.17 Create Contact and Update Task share ONE rotation cursor for this automation — consecutive calls picked different people (${rr1[0].owner_id} then ${rr2[0].assigned_to})`,
  );

  // =================================================================
  head("update_contact_via_automation — same targeting shape");
  // =================================================================
  async function updateContact(args) {
    const { rows } = await db.query(
      `select public.update_contact_via_automation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) as r`,
      [...args, ...LINEAGE],
    );
    return rows[0].r;
  }

  const primaryContactKey = "create-contact-node-1";
  const primaryContact = await makeContactWithKey(ids.custA, ids.leadA, ids.repA, primaryContactKey);

  check(
    (await updateContact(["wrong", ids.custA, primaryContactKey, auto.automationId, "ck0", null, null, null, null, null, false, "Fixed", null, []])) === "unauthorized",
    "5.1 wrong token -> unauthorized",
  );
  const cupd = await updateContact([T, ids.custA, primaryContactKey, auto.automationId, "contact-upd-1", "New Name", "New Co", null, null, null, false, "Fixed", null, []]);
  check(cupd === "updated", `5.2 a valid update succeeds (got ${cupd})`);
  const { rows: afterCupd } = await db.query(`select name, company, status from public.contacts where id=$1`, [primaryContact.id]);
  check(afterCupd[0].name === "New Name" && afterCupd[0].company === "New Co", "5.3 fields changed as requested");
  check(afterCupd[0].status === "Active", "5.4 status column untouched by an ordinary update");

  check(
    (await updateContact([T, ids.custA, primaryContactKey, auto.automationId, "contact-upd-2", "   ", null, null, null, null, false, "Fixed", null, []])) === "invalid_name",
    "5.5 blanking the name via whitespace -> invalid_name",
  );
  check(
    (await updateContact([T, ids.custB, primaryContactKey, autoB.automationId, "contact-upd-3", "X", null, null, null, null, false, "Fixed", null, []])) === "target_not_found",
    "5.6 customer B calling with customer A's target key -> target_not_found",
  );
  check(
    (await updateContact([T, ids.custA, "no-such-create-node-key", auto.automationId, "contact-upd-nf", "X", null, null, null, null, false, "Fixed", null, []])) === "target_not_found",
    "5.7 a target key naming no row -> target_not_found",
  );

  // =================================================================
  head("deactivate_task_via_automation / deactivate_contact_via_automation — one-way, never a real DELETE");
  // =================================================================
  async function deactivateTask(args) {
    const { rows } = await db.query(
      `select public.deactivate_task_via_automation($1,$2,$3,$4,$5,$6,$7,$8) as r`,
      [...args, ...LINEAGE],
    );
    return rows[0].r;
  }
  async function deactivateContact(args) {
    const { rows } = await db.query(
      `select public.deactivate_contact_via_automation($1,$2,$3,$4,$5,$6,$7,$8) as r`,
      [...args, ...LINEAGE],
    );
    return rows[0].r;
  }

  check((await deactivateTask(["wrong", ids.custA, primaryTaskKey, auto.automationId, "dk0"])) === "unauthorized", "6.1 wrong token -> unauthorized");

  const beforeCount = await db.query(`select count(*)::int n from public.tasks where customer_id=$1`, [ids.custA]);
  const deact = await deactivateTask([T, ids.custA, primaryTaskKey, auto.automationId, "deact-task-1"]);
  check(deact === "deactivated", `6.2 a valid deactivate call succeeds (got ${deact})`);
  const { rows: afterDeact } = await db.query(`select activation_status, subject from public.tasks where id=$1`, [primaryTask.id]);
  check(afterDeact[0].activation_status === "Inactive", "6.3 activation_status is now Inactive");
  check(afterDeact[0].subject === "Updated subject", "6.4 every other column is untouched by deactivation");
  const afterCount = await db.query(`select count(*)::int n from public.tasks where customer_id=$1`, [ids.custA]);
  check(afterCount.rows[0].n === beforeCount.rows[0].n, `6.5 row count is UNCHANGED — this was never a DELETE (before ${beforeCount.rows[0].n}, after ${afterCount.rows[0].n})`);

  const deactRetry = await deactivateTask([T, ids.custA, primaryTaskKey, auto.automationId, "deact-task-1"]);
  check(deactRetry === "duplicate", "6.6 retrying the same key -> duplicate, idempotent");

  const deactAgain = await deactivateTask([T, ids.custA, primaryTaskKey, auto.automationId, "deact-task-2"]);
  check(deactAgain === "deactivated", "6.7 deactivating an ALREADY-Inactive task with a NEW key still reports success (idempotent no-op)");
  const { rows: stillInactive } = await db.query(`select activation_status from public.tasks where id=$1`, [primaryTask.id]);
  check(stillInactive[0].activation_status === "Inactive", "6.8 still Inactive — never flips back to Active through this function (one-way, no reactivate path)");

  const contactDeact = await deactivateContact([T, ids.custA, primaryContactKey, auto.automationId, "deact-contact-1"]);
  check(contactDeact === "deactivated", "6.9 contact deactivation succeeds the same way");
  const { rows: afterContactDeact } = await db.query(`select status, name from public.contacts where id=$1`, [primaryContact.id]);
  check(afterContactDeact[0].status === "Inactive" && afterContactDeact[0].name === "New Name", "6.10 contact: status flips, every other column untouched");

  check(
    (await deactivateTask([T, ids.custA, "no-such-key", auto.automationId, "deact-task-3"])) === "target_not_found",
    "6.11 a target key naming no task -> target_not_found",
  );
  check(
    (await deactivateContact([T, ids.custA, "no-such-key", auto.automationId, "deact-contact-2"])) === "target_not_found",
    "6.12 a target key naming no contact -> target_not_found",
  );

  // =================================================================
  head("A record with NO automation_key (not made by any automation) is structurally unreachable");
  // =================================================================
  // freshTaskRows/freshContactRows above were inserted with no
  // automation_key at all — the human-created shape. Nothing an
  // automation names can ever resolve automation_key = NULL, because
  // SQL equality with NULL is never true, not even NULL = NULL.
  check(
    freshTaskRows[0].automation_key === undefined || freshTaskRows[0].automation_key === null,
    "6.13 setup sanity: the no-key task really has no automation_key",
  );
  const noKeyTaskAttempt = await updateTask([T, ids.custA, null, auto.automationId, "no-key-attempt-1", "X", null, null, null, null, null, false, "Fixed", null, []]);
  check(noKeyTaskAttempt === "target_not_found", `6.14 passing NULL as the target key -> target_not_found, never matches a human-created row (got ${noKeyTaskAttempt})`);

  // =================================================================
  head("An Inactive record refuses further automation writes — 'record_inactive'");
  // =================================================================
  const guardTaskKey = "guard-create-task";
  const guardContactKey = "guard-create-contact";
  const guardTask = await makeTaskWithKey(ids.custA, ids.leadA, ids.repA, guardTaskKey, "Guard task");
  const guardContact = await makeContactWithKey(ids.custA, ids.leadA, ids.repA, guardContactKey, "Guard Contact");

  check((await deactivateTask([T, ids.custA, guardTaskKey, auto.automationId, "guard-deact-task"])) === "deactivated", "7.1 setup: guard task deactivated");
  check((await deactivateContact([T, ids.custA, guardContactKey, auto.automationId, "guard-deact-contact"])) === "deactivated", "7.2 setup: guard contact deactivated");

  const inactiveTaskUpdate = await updateTask([T, ids.custA, guardTaskKey, auto.automationId, "guard-upd-task-1", "Should not apply", null, null, null, null, null, false, "Fixed", null, []]);
  check(inactiveTaskUpdate === "record_inactive", `7.3 updating an Inactive task -> record_inactive (got ${inactiveTaskUpdate})`);
  const { rows: guardTaskAfter } = await db.query(`select subject, activation_status from public.tasks where id=$1`, [guardTask.id]);
  check(guardTaskAfter[0].subject === "Guard task", "7.4 the rejected write changed NOTHING — no partial modification");
  check(guardTaskAfter[0].activation_status === "Inactive", "7.5 still Inactive — the rejected write did not accidentally reactivate it");

  const inactiveContactUpdate = await updateContact([T, ids.custA, guardContactKey, auto.automationId, "guard-upd-contact-1", "Should not apply", null, null, null, null, false, "Fixed", null, []]);
  check(inactiveContactUpdate === "record_inactive", `7.6 updating an Inactive contact -> record_inactive (got ${inactiveContactUpdate})`);
  const { rows: guardContactAfter } = await db.query(`select name, status from public.contacts where id=$1`, [guardContact.id]);
  check(guardContactAfter[0].name === "Guard Contact", "7.7 the rejected write changed NOTHING on the contact either");

  // Cross-tenant + inactive together: the tenant boundary must win, not
  // leak "record_inactive" as a signal that a record exists (just
  // inactive) in a tenant the caller cannot see.
  const crossTenantInactive = await updateTask([T, ids.custB, guardTaskKey, autoB.automationId, "guard-upd-task-2", "X", null, null, null, null, null, false, "Fixed", null, []]);
  check(crossTenantInactive === "target_not_found", `7.8 a DIFFERENT tenant querying an inactive task's key from tenant A -> target_not_found, not record_inactive (got ${crossTenantInactive})`);

  // Ordering: idempotency is still checked FIRST, exactly like every
  // other validation step in this function — a key already consumed by
  // a real success reports 'duplicate' even after the record has since
  // gone Inactive, never re-evaluating activation for an already-settled
  // key.
  const reuseTaskKey = "reuse-create-task";
  const reuseTask = await makeTaskWithKey(ids.custA, ids.leadA, ids.repA, reuseTaskKey, "Reuse task");
  const firstCall = await updateTask([T, ids.custA, reuseTaskKey, auto.automationId, "guard-reuse-key", "First edit", null, null, null, null, null, false, "Fixed", null, []]);
  check(firstCall === "updated", "7.9 setup: first call on an Active task succeeds");
  check((await deactivateTask([T, ids.custA, reuseTaskKey, auto.automationId, "guard-reuse-deact"])) === "deactivated", "7.10 setup: then deactivated");
  const retryCall = await updateTask([T, ids.custA, reuseTaskKey, auto.automationId, "guard-reuse-key", "Second edit — should never apply", null, null, null, null, null, false, "Fixed", null, []]);
  check(retryCall === "duplicate", `7.11 retrying the SAME already-used key against the now-Inactive task -> duplicate (idempotency ordering preserved, got ${retryCall})`);
  const { rows: reuseTaskAfter } = await db.query(`select subject from public.tasks where id=$1`, [reuseTask.id]);
  check(reuseTaskAfter[0].subject === "First edit", "7.12 the retry did not re-apply or change anything further");

  // =================================================================
  head("Existing human-facing RLS is untouched — the app's own path, not the automation path");
  // =================================================================
  const repASession = await asUser(ids.repA_auth);
  const { rows: humanTask } = await repASession.query(
    `insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to)
     values ($1,$2,'Human-created task', current_date, $3) returning id, activation_status`,
    [ids.custA, ids.leadA, ids.repA],
  );
  check(humanTask.length === 1 && humanTask[0].activation_status === "Active", "8.1 a real authenticated session can still insert a task exactly as before, defaulting to Active");

  await repASession.query(`update public.tasks set subject = 'Edited by rep' where id = $1`, [humanTask[0].id]);
  const { rows: editedTask } = await repASession.query(`select subject from public.tasks where id = $1`, [humanTask[0].id]);
  check(editedTask[0].subject === "Edited by rep", "8.2 the existing UPDATE policy still lets a visible-hierarchy member edit their own task");

  const repBSession = await asUser(ids.repB_auth);
  const { rows: crossTenantView } = await repBSession.query(`select id from public.tasks where id = $1`, [humanTask[0].id]);
  check(crossTenantView.length === 0, "8.3 RLS still hides customer A's task from customer B's rep");

  const { rows: humanContact } = await repASession.query(
    `insert into public.contacts (customer_id, lead_id, owner_id, name) values ($1,$2,$3,'Human Contact') returning id, status`,
    [ids.custA, ids.leadA, ids.repA],
  );
  check(humanContact.length === 1 && humanContact[0].status === "Active", "8.4 a real authenticated session can still insert a contact exactly as before, defaulting to Active");

  const { rows: crossTenantContact } = await repBSession.query(`select id from public.contacts where id = $1`, [humanContact[0].id]);
  check(crossTenantContact.length === 0, "8.5 RLS still hides customer A's contact from customer B's rep");

  await repASession.end();
  await repBSession.end();

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
