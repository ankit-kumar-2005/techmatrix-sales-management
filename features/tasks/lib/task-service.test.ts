import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeSupabase, eqValue, type RecordedCall } from "@/test/fake-supabase";
import type { DomainActor } from "@/types/customer";
import { createTaskSchema, updateTaskSchema } from "../schemas";
import { completeTask, createTask, updateTask } from "./task-service";

/**
 * CHARACTERIZATION OF THE TASK WRITE PATH — transcribed from
 * createTaskAction/updateTaskAction/completeTaskAction before the move.
 * Authorization is RLS's job here (unchanged); what these pin is the
 * exact payload, the tenant filters, and the user-facing messages.
 */

const LEAD = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const actor: DomainActor = { userId: "auth-mgr", customerId: "cust-a", customerUserId: "cu-mgr", role: "MANAGER" };

const form = { subject: "Call Priya", priority: "High", due_date: "2026-10-12", assigned_to: ASSIGNEE, lead_id: LEAD, type: "Call" };

function respond(result: { data: unknown; error: unknown }) {
  return createFakeSupabase(() => result);
}

describe("createTask", () => {
  it("inserts exactly the original columns, with customer_id and created_by from the actor", async () => {
    const parsed = createTaskSchema.parse({ ...form, description: "  " });
    const { client, calls } = respond({ data: { id: "new-task" }, error: null });
    const result = await createTask(client, actor, { ...parsed, customer_id: "cust-EVIL" } as typeof parsed);
    assert.deepEqual(result, { ok: true, id: "new-task" });
    assert.equal(calls[0].table, "tasks");
    assert.deepEqual(calls[0].payload, {
      customer_id: "cust-a",
      lead_id: LEAD,
      subject: "Call Priya",
      description: null,
      priority: "High",
      due_date: "2026-10-12",
      assigned_to: ASSIGNEE,
      type: "Call",
      created_by: "auth-mgr",
    });
    assert.equal(calls[0].returning, "id");
  });

  it("treats a missing returned id as success (Meeting Notes relies on this)", async () => {
    const { client } = respond({ data: null, error: null });
    assert.deepEqual(await createTask(client, actor, createTaskSchema.parse(form)), { ok: true, id: null });
  });

  it("returns the original message when RLS refuses the lead or assignee", async () => {
    const { client } = respond({ data: null, error: { message: "new row violates row-level security policy" } });
    assert.deepEqual(await createTask(client, actor, createTaskSchema.parse(form)), {
      ok: false,
      kind: "failed",
      message: "Unable to create this task. The lead or assignee may not be available to you.",
    });
  });
});

describe("updateTask", () => {
  const parsed = updateTaskSchema.parse({ id: TASK, ...form, status: "Completed" });

  it("updates exactly the original columns, scoped to the id and the actor's customer", async () => {
    const { client, calls } = respond({ data: { id: TASK }, error: null });
    assert.deepEqual(await updateTask(client, actor, parsed), { ok: true, id: TASK });
    const call = calls[0] as RecordedCall;
    assert.deepEqual(call.payload, {
      subject: "Call Priya",
      description: null,
      priority: "High",
      due_date: "2026-10-12",
      assigned_to: ASSIGNEE,
      type: "Call",
      status: "Completed",
    });
    assert.equal(eqValue(call, "id"), TASK);
    assert.equal(eqValue(call, "customer_id"), "cust-a");
  });

  it("reports a task RLS hides as not found, with the original message", async () => {
    const { client } = respond({ data: null, error: null });
    assert.deepEqual(await updateTask(client, actor, parsed), {
      ok: false,
      kind: "not_found",
      message: "This task could not be updated. It may no longer be available to you.",
    });
  });

  it("reports a refused update with the original message", async () => {
    const { client } = respond({ data: null, error: { message: "x" } });
    assert.deepEqual(await updateTask(client, actor, parsed), {
      ok: false,
      kind: "failed",
      message: "Unable to update this task. The assignee may not be available to you.",
    });
  });
});

describe("completeTask", () => {
  it("sets only status = Completed, scoped to the id and the actor's customer", async () => {
    const { client, calls } = respond({ data: { id: TASK }, error: null });
    assert.deepEqual(await completeTask(client, actor, TASK), { ok: true, id: TASK });
    assert.deepEqual(calls[0].payload, { status: "Completed" });
    assert.equal(eqValue(calls[0], "id"), TASK);
    assert.equal(eqValue(calls[0], "customer_id"), "cust-a");
  });

  it("uses the original messages for a hidden task and a refused update", async () => {
    assert.deepEqual(await completeTask(respond({ data: null, error: null }).client, actor, TASK), {
      ok: false,
      kind: "not_found",
      message: "This task could not be updated. It may no longer be available to you.",
    });
    assert.deepEqual(await completeTask(respond({ data: null, error: { message: "x" } }).client, actor, TASK), {
      ok: false,
      kind: "failed",
      message: "Unable to complete this task. Please try again.",
    });
  });
});
