// Real-DB verification for the "Coming soon" sources gaining a real
// customer_integrations row + real webhook token (JustDial, Website,
// Meta) — the exact mechanism this pass reuses from IndiaMART's own
// connect flow, now parameterized by source name instead of hardcoded.
//
// What this proves that reading the code alone does not:
//   1. A real INSERT with source = 'JustDial'/'Website'/'Meta' actually
//      succeeds against the real schema/RLS, and actually gets a real
//      64-hex webhook_token from the column's own DEFAULT.
//   2. Re-running that same insert (simulating a second page load) is
//      a harmless no-op — no duplicate row, no token change — via the
//      (customer_id, source) uniqueness constraint, exactly like
//      connectIndiamartAction's own idempotent-insert handling.
//   3. IndiaMART's OWN real row, insert, and token are completely
//      unaffected by these three siblings existing alongside it.
//   4. Regenerating a JustDial row's token works through the exact
//      same UPDATE query regenerateWebhookTokenAction already uses
//      (by id + customer_id, never touching `source`) — proving no
//      change is needed there for these three to support Regenerate.
//   5. RLS still isolates tenants and blocks non-admins for these rows
//      exactly as it already does for IndiaMART's.
import { randomUUID } from "node:crypto";
import { asAnon, asUser, client, seed } from "./seed.mjs";

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

const HEX64 = /^[0-9a-f]{64}$/;

async function main() {
  const ids = await seed();
  const db = client();
  await db.connect();

  head("Provisioning a real row for each 'Soon' source — the exact insert ensureComingSoonIntegrationExists runs");

  const adminA = await asUser(ids.adminA_auth);

  const created = {};
  for (const source of ["JustDial", "Website", "Meta"]) {
    const { rows } = await adminA.query(
      `insert into public.customer_integrations (customer_id, source) values ($1, $2)
       returning id, source, webhook_token, status`,
      [ids.custA, source],
    );
    created[source] = rows[0];
    check(rows.length === 1, `1.${source} row insert succeeds`);
    check(HEX64.test(rows[0].webhook_token), `1.${source} webhook_token is a real 64-hex value (got length ${rows[0].webhook_token.length})`);
    check(rows[0].status === "Active", `1.${source} defaults to Active status`);
  }

  // All three tokens must be genuinely distinct from each other and
  // from nothing — the column DEFAULT calls gen_random_uuid() twice per
  // row, independently each time.
  const tokens = Object.values(created).map((r) => r.webhook_token);
  check(new Set(tokens).size === 3, "1.4 all three tokens are distinct from each other");

  head("Re-provisioning (simulating a second page load) is a harmless no-op");

  let duplicateError = null;
  try {
    await adminA.query(`insert into public.customer_integrations (customer_id, source) values ($1, $2)`, [
      ids.custA,
      "JustDial",
    ]);
  } catch (error) {
    duplicateError = error;
  }
  check(duplicateError?.code === "23505", `2.1 a second insert for the same (customer, source) hits the unique constraint (got ${duplicateError?.code})`);

  const { rows: stillOne } = await adminA.query(
    `select id, webhook_token from public.customer_integrations where customer_id = $1 and source = 'JustDial'`,
    [ids.custA],
  );
  check(stillOne.length === 1, "2.2 still exactly one JustDial row for this tenant");
  check(stillOne[0].webhook_token === created.JustDial.webhook_token, "2.3 its token is unchanged by the failed duplicate insert");

  head("IndiaMART's own real row is unaffected by these three siblings existing");

  const { rows: indiamart } = await adminA.query(
    `insert into public.customer_integrations (customer_id, source) values ($1, 'IndiaMART')
     returning id, source, webhook_token`,
    [ids.custA],
  );
  check(HEX64.test(indiamart[0].webhook_token), "3.1 IndiaMART's own row still gets a real 64-hex token, unchanged mechanism");

  const { rows: allForCustA } = await adminA.query(
    `select source from public.customer_integrations where customer_id = $1 order by source`,
    [ids.custA],
  );
  check(
    allForCustA.map((r) => r.source).join(",") === "IndiaMART,JustDial,Meta,Website",
    `3.2 all four rows coexist for this tenant, IndiaMART's included (got: ${allForCustA.map((r) => r.source).join(",")})`,
  );

  head("Regenerate works on a JustDial row through the identical query regenerateWebhookTokenAction uses (by id + customer_id, never touching source)");

  // Same construction regenerateWebhookTokenAction itself uses.
  const newToken = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const { rowCount: regenCount } = await adminA.query(
    `update public.customer_integrations set webhook_token = $1 where id = $2 and customer_id = $3`,
    [newToken, created.JustDial.id, ids.custA],
  );
  check(regenCount === 1, "4.1 regenerate updates exactly the JustDial row");

  const { rows: afterRegen } = await adminA.query(
    `select webhook_token from public.customer_integrations where id = $1`,
    [created.JustDial.id],
  );
  check(afterRegen[0].webhook_token === newToken, "4.2 the new token is actually stored");
  check(afterRegen[0].webhook_token !== created.JustDial.webhook_token, "4.3 the old token no longer matches");

  head("Tenant isolation still holds for these three, exactly as it already does for IndiaMART");

  const adminB = await asUser(ids.adminB_auth);
  const { rows: custBJustDial } = await adminB.query(
    `insert into public.customer_integrations (customer_id, source) values ($1, 'JustDial')
     returning id, webhook_token`,
    [ids.custB],
  );
  check(HEX64.test(custBJustDial[0].webhook_token), "5.1 Customer B can provision its OWN JustDial row independently");
  check(custBJustDial[0].webhook_token !== created.JustDial.webhook_token, "5.2 Customer B's token is distinct from Customer A's");

  const { rows: crossTenantRead } = await adminB.query(
    `select id from public.customer_integrations where id = $1`,
    [created.JustDial.id],
  );
  check(crossTenantRead.length === 0, "5.3 Customer B's admin cannot see Customer A's JustDial row (RLS)");

  head("Non-admins cannot create one of these rows either (same RLS as IndiaMART's)");

  const repA = await asUser(ids.repA_auth);
  let repInsertError = null;
  try {
    await repA.query(`insert into public.customer_integrations (customer_id, source) values ($1, 'Meta')`, [ids.custA]);
  } catch (error) {
    repInsertError = error;
  }
  check(repInsertError?.code === "42501", `6.1 a non-admin is refused by RLS, same as for IndiaMART (got ${repInsertError?.code})`);

  const anon = await asAnon();
  let anonInsertError = null;
  try {
    await anon.query(`insert into public.customer_integrations (customer_id, source) values ($1, 'Meta')`, [ids.custA]);
  } catch (error) {
    anonInsertError = error;
  }
  check(anonInsertError?.code === "42501", `6.2 anon is refused too (got ${anonInsertError?.code})`);

  await adminA.end();
  await adminB.end();
  await repA.end();
  await anon.end();
  await db.end();

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  if (fail > 0) {
    console.log("Failures:", failures);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
