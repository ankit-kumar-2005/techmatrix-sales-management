import pg from "pg";

export function client(database = "automation_test") {
  return new pg.Client({
    host: "127.0.0.1",
    port: 55432,
    user: "postgres",
    password: "postgres",
    database,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
}

/** A connection acting as `authenticated` with auth.uid() bound to one
 *  user — the shape a real Supabase request has. */
export async function asUser(userId) {
  const c = client();
  await c.connect();
  await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await c.query(`set role authenticated`);
  return c;
}

export async function asAnon() {
  const c = client();
  await c.connect();
  await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
  await c.query(`set role anon`);
  return c;
}

/**
 * Two tenants with a full role hierarchy each, so every RLS scenario the
 * review asks for has real rows behind it.
 *
 *   Customer A: adminA, managerA -> seniorA -> repA
 *   Customer B: adminB, repB
 */
export async function seed() {
  const db = client();
  await db.connect();

  // Superuser bypasses RLS, which is what makes seeding possible at all.
  await db.query(`
    truncate public.customer_automation_runs, public.automation_events,
             public.customer_automation_versions, public.customer_automations,
             public.automation_action_executions,
             public.contact_duplicate_dismissals, public.contacts,
             public.tasks, public.leads, public.customer_integration_participants,
             public.customer_integrations, public.customer_lead_stages,
             public.customer_users, public.customers cascade;
    delete from auth.users;
  `);

  const roles = await db.query(`select id, name from public.roles`);
  const roleId = Object.fromEntries(roles.rows.map((r) => [r.name, r.id]));

  const ids = {};

  async function makeUser(key, email) {
    const { rows } = await db.query(`insert into auth.users (email) values ($1) returning id`, [email]);
    ids[`${key}_auth`] = rows[0].id;
    return rows[0].id;
  }

  async function makeCustomer(key, name, creatorAuthId) {
    const { rows } = await db.query(
      `insert into public.customers (name, company_name, email, phone, created_by)
       values ($1, $1, $2, '0000000000', $3) returning id`,
      [name, `${name.toLowerCase()}@example.test`, creatorAuthId],
    );
    ids[key] = rows[0].id;
    return rows[0].id;
  }

  async function makeMember(key, customerId, authId, role, managerId = null, status = "Active") {
    const { rows } = await db.query(
      `insert into public.customer_users (customer_id, user_id, role_id, manager_id, status, name)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [customerId, authId, roleId[role], managerId, status, key],
    );
    ids[key] = rows[0].id;
    return rows[0].id;
  }

  async function makeStage(key, customerId, stage, order) {
    const { rows } = await db.query(
      `insert into public.customer_lead_stages (customer_id, stage, display_order, status, is_closed, probability)
       values ($1, $2, $3, 'Active', false, 10) returning id`,
      [customerId, stage, order],
    );
    ids[key] = rows[0].id;
    return rows[0].id;
  }

  async function makeLead(key, customerId, stageId, ownerId, company, source) {
    const { rows } = await db.query(
      `insert into public.leads (customer_id, company, contact_name, stage_id, owner_id, source, status)
       values ($1, $2, $3, $4, $5, $6, 'Active') returning id`,
      [customerId, company, `${company} Contact`, stageId, ownerId, source],
    );
    ids[key] = rows[0].id;
    return rows[0].id;
  }

  // ---- Customer A ----
  const adminAAuth = await makeUser("adminA", "admin.a@example.test");
  const custA = await makeCustomer("custA", "CustomerA", adminAAuth);
  await makeMember("adminA", custA, adminAAuth, "ADMIN");

  const managerAAuth = await makeUser("managerA", "manager.a@example.test");
  const managerA = await makeMember("managerA", custA, managerAAuth, "MANAGER");

  const seniorAAuth = await makeUser("seniorA", "senior.a@example.test");
  const seniorA = await makeMember("seniorA", custA, seniorAAuth, "SENIOR_SALES_REP", managerA);

  const repAAuth = await makeUser("repA", "rep.a@example.test");
  await makeMember("repA", custA, repAAuth, "SALES_REP", seniorA);

  const inactiveAAuth = await makeUser("inactiveA", "inactive.a@example.test");
  await makeMember("inactiveA", custA, inactiveAAuth, "SALES_REP", seniorA, "Inactive");

  const stageA = await makeStage("stageA", custA, "New", 1);
  await makeLead("leadA", custA, stageA, ids.repA, "Acme A", "IndiaMART");
  await makeLead("leadA2", custA, stageA, null, "Acme A2", null);

  // ---- Customer B ----
  const adminBAuth = await makeUser("adminB", "admin.b@example.test");
  const custB = await makeCustomer("custB", "CustomerB", adminBAuth);
  await makeMember("adminB", custB, adminBAuth, "ADMIN");

  const repBAuth = await makeUser("repB", "rep.b@example.test");
  await makeMember("repB", custB, repBAuth, "SALES_REP");

  const stageB = await makeStage("stageB", custB, "New", 1);
  await makeLead("leadB", custB, stageB, ids.repB, "Beta B", "IndiaMART");

  // No token is seeded by the migration any more — the suite mints one
  // with rotate_automation_worker_token(), which is itself under test.
  ids.token = null;

  await db.end();
  return ids;
}

/** A minimal valid workflow: lead.created (any source) -> task.create
 *  assigned to one fixed person. */
export function workflow(assigneeId, overrides = {}) {
  return {
    nodes: [
      { id: "t1", kind: "trigger", type: "lead.created", position: { x: 0, y: 0 }, config: { sources: [] } },
      {
        id: "a1",
        kind: "action",
        type: "task.create",
        position: { x: 300, y: 0 },
        config: {
          subject: "Call {{lead.company}}",
          description: null,
          type: "Call",
          priority: "High",
          dueInDays: 1,
          assignmentMode: "Fixed",
          assigneeId,
          rotation: [],
          ...overrides,
        },
      },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
}

/** Creates an automation + version directly (superuser), returning both
 *  ids. `status` and whether active_version_id is set are parameters so
 *  the eligibility tests can build Draft/Inactive automations. */
export async function makeAutomation(db, { customerId, name, definition, status, setActive = true, createdBy = null }) {
  const { rows: aRows } = await db.query(
    `insert into public.customer_automations (customer_id, name, status, origin, created_by)
     values ($1, $2, 'Draft', 'Manual', $3) returning id`,
    [customerId, name, createdBy],
  );
  const automationId = aRows[0].id;

  const { rows: vRows } = await db.query(
    `insert into public.customer_automation_versions
       (customer_id, automation_id, version, trigger_type, definition, created_by)
     values ($1, $2, 1, 'lead.created', $3, $4) returning id`,
    [customerId, automationId, JSON.stringify(definition), createdBy],
  );
  const versionId = vRows[0].id;

  if (status === "Active" || setActive) {
    await db.query(`update public.customer_automations set active_version_id = $1 where id = $2`, [
      versionId,
      automationId,
    ]);
  }
  if (status && status !== "Draft") {
    await db.query(`update public.customer_automations set status = $1 where id = $2`, [status, automationId]);
  }

  return { automationId, versionId };
}
