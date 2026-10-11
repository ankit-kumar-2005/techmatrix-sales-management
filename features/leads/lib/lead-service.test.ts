import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeSupabase, eqValue, type RecordedCall } from "@/test/fake-supabase";
import type { DomainActor } from "@/types/customer";
import { createLeadSchema, updateLeadSchema } from "../schemas";
import { createLead, updateLead } from "./lead-service";

/**
 * CHARACTERIZATION OF THE LEAD WRITE PATH.
 *
 * Every expectation below is transcribed from createLeadAction/
 * updateLeadAction as they were BEFORE the logic moved into
 * lead-service.ts: the same queries, the same payload keys and values,
 * the same tenant filters, the same user-facing strings. The services are
 * now the only copy of that logic (both the Server Actions and the MCP
 * tools call them), so these tests pin the behaviour for both callers.
 *
 * Inputs go through the real createLeadSchema/updateLeadSchema first,
 * exactly as both callers do, so the shapes are the real parsed shapes.
 */

const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STAGE_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const REP_CU = "44444444-4444-4444-8444-444444444444";
const OTHER_CU = "55555555-5555-4555-8555-555555555555";

const admin: DomainActor = { userId: "auth-admin", customerId: "cust-a", customerUserId: "cu-admin", role: "ADMIN" };
const rep: DomainActor = { userId: "auth-rep", customerId: "cust-a", customerUserId: REP_CU, role: "SALES_REP" };

const baseForm = {
  contact_name: "Priya Shah",
  phone: "+91 98765 43210",
  stage_id: STAGE_ID,
  company: "Meridian Foods",
};

function parseCreate(extra: Record<string, string> = {}) {
  const parsed = createLeadSchema.safeParse({ ...baseForm, ...extra });
  assert.ok(parsed.success);
  return parsed.data;
}

function parseUpdate(extra: Record<string, string> = {}) {
  const parsed = updateLeadSchema.safeParse({ id: LEAD_ID, ...baseForm, ...extra });
  assert.ok(parsed.success);
  return parsed.data;
}

type World = {
  stage?: { id: string; status: string } | null;
  stageError?: boolean;
  insertError?: boolean;
  existingLead?: { id: string; owner_id: string | null; stage_id: string; closed_at: string | null } | null;
  updateResult?: { id: string } | null;
  updateError?: boolean;
};

function world(w: World) {
  return createFakeSupabase((call: RecordedCall) => {
    if (call.table === "customer_lead_stages") {
      return { data: w.stageError ? null : (w.stage ?? null), error: w.stageError ? { message: "x" } : null };
    }
    if (call.table === "leads" && call.op === "insert") {
      return w.insertError ? { data: null, error: { message: "denied" } } : { data: { id: "new-lead" }, error: null };
    }
    if (call.table === "leads" && call.op === "select") {
      return { data: w.existingLead ?? null, error: null };
    }
    if (call.table === "leads" && call.op === "update") {
      return w.updateError ? { data: null, error: { message: "x" } } : { data: w.updateResult ?? null, error: null };
    }
    throw new Error(`unexpected call ${call.op} ${call.table}`);
  });
}

describe("createLead", () => {
  it("re-checks the stage under the caller's own customer before inserting", async () => {
    const { client, calls } = world({ stage: { id: STAGE_ID, status: "Active" } });
    await createLead(client, rep, parseCreate());
    const stageCall = calls[0];
    assert.equal(stageCall.table, "customer_lead_stages");
    assert.equal(eqValue(stageCall, "id"), STAGE_ID);
    assert.equal(eqValue(stageCall, "customer_id"), "cust-a");
  });

  it("rejects an unknown stage with the original field error and never inserts", async () => {
    const { client, calls } = world({ stage: null });
    const result = await createLead(client, rep, parseCreate());
    assert.deepEqual(result, { ok: false, kind: "invalid", fieldErrors: { stage_id: "Select a valid stage." } });
    assert.equal(calls.filter((c) => c.op === "insert").length, 0);
  });

  it("rejects an inactive stage with the original field error", async () => {
    const { client } = world({ stage: { id: STAGE_ID, status: "Inactive" } });
    const result = await createLead(client, rep, parseCreate());
    assert.deepEqual(result, {
      ok: false,
      kind: "invalid",
      fieldErrors: { stage_id: "That stage is no longer active. Please choose another." },
    });
  });

  it("forces a non-admin's lead to be owned by themselves, ignoring a submitted owner", async () => {
    const { client, calls } = world({ stage: { id: STAGE_ID, status: "Active" } });
    await createLead(client, rep, parseCreate({ owner_id: OTHER_CU }));
    const insert = calls.find((c) => c.op === "insert");
    assert.equal((insert?.payload as Record<string, unknown>).owner_id, REP_CU);
  });

  it("honours an admin's chosen owner, and null when none was chosen", async () => {
    const chosen = world({ stage: { id: STAGE_ID, status: "Active" } });
    await createLead(chosen.client, admin, parseCreate({ owner_id: OTHER_CU }));
    assert.equal((chosen.calls.find((c) => c.op === "insert")?.payload as Record<string, unknown>).owner_id, OTHER_CU);

    const none = world({ stage: { id: STAGE_ID, status: "Active" } });
    await createLead(none.client, admin, parseCreate());
    assert.equal((none.calls.find((c) => c.op === "insert")?.payload as Record<string, unknown>).owner_id, null);
  });

  it("writes exactly the original column set, with customer_id from the actor", async () => {
    const { client, calls } = world({ stage: { id: STAGE_ID, status: "Active" } });
    const input = { ...parseCreate({ whatsapp_same: "on", deal_value: "18000" }), customer_id: "cust-EVIL" };
    const result = await createLead(client, rep, input);
    assert.deepEqual(result, { ok: true, id: "new-lead" });
    const insert = calls.find((c) => c.op === "insert");
    assert.deepEqual(insert?.payload, {
      customer_id: "cust-a",
      company: "Meridian Foods",
      contact_name: "Priya Shah",
      email: null,
      phone: "+91 98765 43210",
      whatsapp_phone: "+91 98765 43210",
      address: null,
      deal_value: 18000,
      expected_close_date: null,
      stage_id: STAGE_ID,
      owner_id: REP_CU,
      source: null,
      next_step: null,
    });
  });

  it("returns the original generic message when the insert is refused", async () => {
    const { client } = world({ stage: { id: STAGE_ID, status: "Active" }, insertError: true });
    const result = await createLead(client, rep, parseCreate());
    assert.deepEqual(result, {
      ok: false,
      kind: "failed",
      message: "Something went wrong creating the lead. Please try again.",
    });
  });
});

describe("updateLead", () => {
  const openOwnLead = { id: LEAD_ID, owner_id: REP_CU, stage_id: STAGE_ID, closed_at: null };

  it("says 'Lead not found.' for a lead that does not exist or is hidden by RLS", async () => {
    const { client, calls } = world({ existingLead: null });
    const result = await updateLead(client, rep, parseUpdate());
    assert.deepEqual(result, { ok: false, kind: "not_found", message: "Lead not found." });
    assert.equal(eqValue(calls[0], "customer_id"), "cust-a");
  });

  it("refuses a closed lead", async () => {
    const { client, calls } = world({ existingLead: { ...openOwnLead, closed_at: "2026-10-01T00:00:00Z" } });
    const result = await updateLead(client, rep, parseUpdate());
    assert.deepEqual(result, { ok: false, kind: "forbidden", message: "This lead is closed and cannot be edited." });
    assert.equal(calls.filter((c) => c.op === "update").length, 0);
  });

  it("refuses a non-admin editing somebody else's lead (visibility is not edit rights)", async () => {
    const { client, calls } = world({ existingLead: { ...openOwnLead, owner_id: OTHER_CU } });
    const result = await updateLead(client, rep, parseUpdate());
    assert.deepEqual(result, { ok: false, kind: "forbidden", message: "You don't have permission to edit this lead." });
    assert.equal(calls.filter((c) => c.op === "update").length, 0);
  });

  it("does not re-check the stage when it is unchanged", async () => {
    const { client, calls } = world({ existingLead: openOwnLead, updateResult: { id: LEAD_ID } });
    await updateLead(client, rep, parseUpdate());
    assert.equal(calls.filter((c) => c.table === "customer_lead_stages").length, 0);
  });

  it("re-checks a changed stage and rejects an inactive one", async () => {
    const { client } = world({ existingLead: openOwnLead, stage: { id: OTHER_STAGE_ID, status: "Inactive" } });
    const result = await updateLead(client, rep, parseUpdate({ stage_id: OTHER_STAGE_ID }));
    assert.deepEqual(result, {
      ok: false,
      kind: "invalid",
      fieldErrors: { stage_id: "That stage is no longer active. Please choose another." },
    });
  });

  it("never writes owner_id for a non-admin, even when one was submitted", async () => {
    const { client, calls } = world({ existingLead: openOwnLead, updateResult: { id: LEAD_ID } });
    const result = await updateLead(client, rep, parseUpdate({ owner_id: OTHER_CU }));
    assert.deepEqual(result, { ok: true, id: LEAD_ID });
    const update = calls.find((c) => c.op === "update");
    assert.equal("owner_id" in (update?.payload as object), false);
    assert.equal(eqValue(update as RecordedCall, "id"), LEAD_ID);
    assert.equal(eqValue(update as RecordedCall, "customer_id"), "cust-a");
  });

  it("writes owner_id for an admin", async () => {
    const { client, calls } = world({ existingLead: { ...openOwnLead, owner_id: OTHER_CU }, updateResult: { id: LEAD_ID } });
    await updateLead(client, admin, parseUpdate({ owner_id: REP_CU }));
    assert.equal((calls.find((c) => c.op === "update")?.payload as Record<string, unknown>).owner_id, REP_CU);
  });

  it("reports a row RLS excluded mid-flight with the original message", async () => {
    const { client } = world({ existingLead: openOwnLead, updateResult: null });
    const result = await updateLead(client, rep, parseUpdate());
    assert.deepEqual(result, {
      ok: false,
      kind: "conflict",
      message: "This lead could not be updated. It may have changed since you opened it.",
    });
  });

  it("reports a refused update with the original generic message", async () => {
    const { client } = world({ existingLead: openOwnLead, updateError: true });
    const result = await updateLead(client, rep, parseUpdate());
    assert.deepEqual(result, {
      ok: false,
      kind: "failed",
      message: "Something went wrong updating the lead. Please try again.",
    });
  });
});
