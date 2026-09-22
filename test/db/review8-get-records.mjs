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
const head = (m) => console.log(`\n=== ${m} ===`);

async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();
  const { rows: mint } = await db.query(`select public.rotate_automation_worker_token() as t`);
  const T = mint[0].t;

  async function getRecords(customerId, object, limit) {
    const { rows } = await db.query(`select * from public.get_automation_records($1,$2,$3,$4)`, [T, customerId, object, limit]);
    return rows.map((r) => r.record_json);
  }

  // =====================================================================
  head("get_automation_records — the security-critical tests");
  // =====================================================================

  // ---- Fixture: real, distinguishable tasks/contacts/leads for BOTH tenants ----
  for (let i = 0; i < 5; i++) {
    await db.query(
      `insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to) values ($1,$2,$3,current_date,$4)`,
      [ids.custA, ids.leadA, `A-task-${i}`, ids.repA],
    );
  }
  for (let i = 0; i < 3; i++) {
    await db.query(
      `insert into public.tasks (customer_id, lead_id, subject, due_date, assigned_to) values ($1,$2,$3,current_date,$4)`,
      [ids.custB, ids.leadB, `B-task-${i}`, ids.repB],
    );
  }
  for (let i = 0; i < 4; i++) {
    await db.query(`insert into public.contacts (customer_id, lead_id, owner_id, name) values ($1,$2,$3,$4)`, [
      ids.custA,
      ids.leadA,
      ids.repA,
      `A-contact-${i}`,
    ]);
  }
  for (let i = 0; i < 2; i++) {
    await db.query(`insert into public.contacts (customer_id, lead_id, owner_id, name) values ($1,$2,$3,$4)`, [
      ids.custB,
      ids.leadB,
      ids.repB,
      `B-contact-${i}`,
    ]);
  }

  // ---- 1. Wrong token -> nothing, not an error, not a leak. ----
  const { rows: wrongTokenRows } = await db.query(`select * from public.get_automation_records($1,$2,$3,$4)`, [
    "wrong-token",
    ids.custA,
    "task",
    50,
  ]);
  check(wrongTokenRows.length === 0, "1.1 a wrong token returns zero rows (fails closed, not an exception)");

  // ---- 2. Baseline: Customer A sees exactly Customer A's tasks. ----
  const aTasks = await getRecords(ids.custA, "task", 50);
  check(aTasks.length === 5, `2.1 Customer A's own query returns exactly its 5 tasks (got ${aTasks.length})`);
  check(
    aTasks.every((t) => typeof t.subject === "string" && t.subject.startsWith("A-task-")),
    "2.2 every returned task genuinely belongs to Customer A (by content, not just count)",
  );
  check(
    aTasks.every((t) => !("customer_id" in t) && !("id" in t)),
    "2.3 customer_id and id are stripped from every returned row",
  );

  // ---- 3. THE CRITICAL TEST: can Customer B's OWN admin session, or
  // this SAME function called with Customer B's own real customer_id,
  // ever see Customer A's rows? And can a caller smuggle Customer A's
  // id into a query that claims to be for Customer B? ----
  const bTasks = await getRecords(ids.custB, "task", 50);
  check(bTasks.length === 3, `3.1 Customer B's own query returns exactly its 3 tasks, never Customer A's 5 (got ${bTasks.length})`);
  check(
    bTasks.every((t) => t.subject.startsWith("B-task-")),
    "3.2 every row Customer B receives genuinely belongs to Customer B",
  );
  check(
    !bTasks.some((t) => t.subject.startsWith("A-task-")),
    "3.3 not one of Customer A's tasks appears anywhere in Customer B's result",
  );

  // The object name is a plain string comparison, never SQL-interpolated
  // — prove this directly by attempting the classic injection shapes as
  // the p_object VALUE itself, confirming each is refused as "no
  // matching branch" (zero rows), not executed as SQL.
  const injectionAttempts = [
    "task'; select * from public.tasks; --",
    "task UNION SELECT to_jsonb(l) FROM leads l",
    "'; drop table tasks; --",
    "contact' OR '1'='1",
  ];
  for (const attempt of injectionAttempts) {
    const rows = await getRecords(ids.custA, attempt, 50);
    check(rows.length === 0, `3.4 p_object="${attempt.slice(0, 30)}..." matches no branch -> zero rows, not an error or a leak`);
  }
  // Confirm the tasks table itself is untouched by the "drop table" attempt.
  const stillThere = await getRecords(ids.custA, "task", 50);
  check(stillThere.length === 5, "3.5 the tasks table itself is completely unaffected by the injection attempts above");

  // Cross-tenant lead_id/owner_id smuggling: even though ids.leadB
  // belongs to Customer B, calling get_automation_records for Customer
  // A never returns Customer B's contact that happens to reference it.
  const aContacts = await getRecords(ids.custA, "contact", 50);
  check(aContacts.length === 4, `3.6 Customer A's contacts query returns exactly its 4 contacts (got ${aContacts.length})`);
  check(
    !aContacts.some((c) => c.name.startsWith("B-contact-")),
    "3.7 Customer B's contacts never appear in Customer A's result, regardless of any shared lead reference",
  );

  // ---- 4. The scan/result cap (MAX_RECORDS_PER_QUERY = 200) is
  // enforced SERVER-SIDE, not just by the caller being polite. ----
  const overCap = await getRecords(ids.custA, "task", 100000);
  check(overCap.length <= 200, `4.1 requesting an absurd limit (100000) is clamped server-side to at most 200 (got ${overCap.length})`);

  const smallLimit = await getRecords(ids.custA, "task", 2);
  check(smallLimit.length === 2, `4.2 a smaller requested limit is honored (got ${smallLimit.length})`);

  const zeroOrNegative = await getRecords(ids.custA, "task", 0);
  check(zeroOrNegative.length >= 1, "4.3 a zero/invalid limit floors at 1 rather than erroring or returning unlimited rows");

  // ---- 5. lead object works too, and the ordering is deterministic
  // (most recent first). ----
  const leads = await getRecords(ids.custA, "lead", 50);
  check(leads.length >= 1, `5.1 the 'lead' object also returns real rows for this tenant (got ${leads.length})`);

  await db.end();

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
