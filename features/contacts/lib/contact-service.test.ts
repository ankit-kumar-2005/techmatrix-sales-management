import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeSupabase, eqValue } from "@/test/fake-supabase";
import type { DomainActor } from "@/types/customer";
import { createContactSchema, updateContactSchema } from "../schemas";
import { createContact, updateContact } from "./contact-service";

/**
 * CHARACTERIZATION OF THE CONTACT WRITE PATH — transcribed from
 * createContactAction/updateContactAction before the move: SALES_REP
 * owner forcing, everyone else's owner passed through to RLS, exact
 * payloads and messages.
 */

const LEAD = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const rep: DomainActor = { userId: "auth-rep", customerId: "cust-a", customerUserId: "cu-rep", role: "SALES_REP" };
const senior: DomainActor = { userId: "auth-sr", customerId: "cust-a", customerUserId: "cu-sr", role: "SENIOR_SALES_REP" };

const form = { name: "Grace Kim", lead_id: LEAD, owner_id: OWNER, tags: "decision-maker, owner", email: "grace@example.com" };

describe("createContact", () => {
  it("forces a SALES_REP to own the contact, whatever owner was submitted", async () => {
    const { client, calls } = createFakeSupabase(() => ({ data: { id: "c1" }, error: null }));
    await createContact(client, rep, createContactSchema.parse(form));
    assert.equal((calls[0].payload as Record<string, unknown>).owner_id, "cu-rep");
  });

  it("passes any other role's owner through for RLS to judge, with the original column set", async () => {
    const { client, calls } = createFakeSupabase(() => ({ data: { id: "c1" }, error: null }));
    const result = await createContact(client, senior, createContactSchema.parse(form));
    assert.deepEqual(result, { ok: true, id: "c1" });
    assert.deepEqual(calls[0].payload, {
      customer_id: "cust-a",
      lead_id: LEAD,
      owner_id: OWNER,
      name: "Grace Kim",
      company: null,
      title: null,
      email: "grace@example.com",
      phone: null,
      tags: ["decision-maker", "owner"],
      created_by: "auth-sr",
    });
  });

  it("returns the original message when RLS refuses the lead or owner", async () => {
    const { client } = createFakeSupabase(() => ({ data: null, error: { message: "rls" } }));
    assert.deepEqual(await createContact(client, senior, createContactSchema.parse(form)), {
      ok: false,
      kind: "failed",
      message: "Unable to create this contact. The lead or owner may not be available to you.",
    });
  });
});

describe("updateContact", () => {
  const parsed = updateContactSchema.parse({ id: CONTACT, ...form });

  it("updates the original columns scoped to id and customer, forcing a SALES_REP's owner", async () => {
    const { client, calls } = createFakeSupabase(() => ({ data: { id: CONTACT }, error: null }));
    assert.deepEqual(await updateContact(client, rep, parsed), { ok: true, id: CONTACT });
    assert.deepEqual(calls[0].payload, {
      owner_id: "cu-rep",
      name: "Grace Kim",
      company: null,
      title: null,
      email: "grace@example.com",
      phone: null,
      tags: ["decision-maker", "owner"],
    });
    assert.equal(eqValue(calls[0], "id"), CONTACT);
    assert.equal(eqValue(calls[0], "customer_id"), "cust-a");
  });

  it("uses the original messages for a hidden contact and a refused update", async () => {
    const hidden = createFakeSupabase(() => ({ data: null, error: null }));
    assert.deepEqual(await updateContact(hidden.client, senior, parsed), {
      ok: false,
      kind: "not_found",
      message: "This contact could not be updated. It may no longer be available to you.",
    });
    const refused = createFakeSupabase(() => ({ data: null, error: { message: "x" } }));
    assert.deepEqual(await updateContact(refused.client, senior, parsed), {
      ok: false,
      kind: "failed",
      message: "Unable to update this contact. The owner may not be available to you.",
    });
  });
});
