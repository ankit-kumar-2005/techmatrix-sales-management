import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_CONTACT_CREATE,
  ACTION_CONTACT_DEACTIVATE,
  ACTION_CONTACT_UPDATE,
  ACTION_GET_RECORDS,
  ACTION_LEAD_UPDATE,
  ACTION_LOOP,
  ACTION_TASK_DEACTIVATE,
  ACTION_TASK_UPDATE,
  ASSIGNMENT_SET_VARIABLE,
  CONDITION_FIELD_GROUP,
  CONDITION_LEAD_HAS_OWNER,
  CONDITION_LEAD_SOURCE_IS,
  DECISION_MULTI_OUTCOME,
  getRegistryEntry,
} from "./definitions";
import { PALETTE_CATALOG } from "./palette-catalog";

/**
 * WHAT THE "+" PALETTE ACTUALLY OFFERS — asserted directly, because this
 * is a curated allowlist (see palette-catalog.ts's own note) rather than
 * "every registered entry of a kind", and an allowlist can silently go
 * stale in exactly the way a derived list cannot.
 */

describe("PALETTE_CATALOG", () => {
  it("every real item resolves to an actual registry entry", () => {
    for (const category of Object.values(PALETTE_CATALOG)) {
      for (const item of category.items) {
        if (item.status !== "real") continue;
        assert.ok(getRegistryEntry(item.key), `${item.key} is listed as real but is not registered`);
      }
    }
  });

  it('every "soon" item carries a non-empty label and reason, and nothing addable (no key)', () => {
    for (const category of Object.values(PALETTE_CATALOG)) {
      for (const item of category.items) {
        if (item.status !== "soon") continue;
        assert.ok(item.label.trim().length > 0);
        assert.ok(item.description.trim().length > 0);
        assert.ok(!("key" in item), `"${item.label}" must not carry a registry key — that would make it addable`);
      }
    }
  });

  it("Decision is the one visible branching entry — the three legacy condition types are consolidated under it", () => {
    const allKeys = Object.values(PALETTE_CATALOG).flatMap((category) =>
      category.items.filter((item) => item.status === "real").map((item) => item.key),
    );
    assert.ok(allKeys.includes(DECISION_MULTI_OUTCOME));
    for (const legacy of [CONDITION_LEAD_SOURCE_IS, CONDITION_LEAD_HAS_OWNER, CONDITION_FIELD_GROUP]) {
      assert.ok(!allKeys.includes(legacy), `${legacy} must not have its own palette entry any more`);
      // Confirmed still real and untouched in the registry itself — a
      // workflow saved before this change still loads and runs exactly
      // as before. Only its own add-from-palette entry point is gone.
      assert.ok(getRegistryEntry(legacy), `${legacy} must still be a real, working registry entry`);
    }
  });

  it("Assignment is real and addable again", () => {
    const allKeys = Object.values(PALETTE_CATALOG).flatMap((category) =>
      category.items.filter((item) => item.status === "real").map((item) => item.key),
    );
    assert.ok(allKeys.includes(ASSIGNMENT_SET_VARIABLE));
  });

  it("Update Lead is still deliberately absent from the catalog (no add-from-palette entry point)", () => {
    const allKeys = Object.values(PALETTE_CATALOG).flatMap((category) =>
      category.items.filter((item) => item.status === "real").map((item) => item.key),
    );
    assert.ok(!allKeys.includes(ACTION_LEAD_UPDATE));
    // Confirmed still real in the registry itself — only hidden from the
    // palette/insert-menu, never removed as a capability.
    assert.ok(getRegistryEntry(ACTION_LEAD_UPDATE));
  });

  it("Update/Deactivate Task and Contact, and Create Contact, are all real and addable", () => {
    const allKeys = Object.values(PALETTE_CATALOG).flatMap((category) =>
      category.items.filter((item) => item.status === "real").map((item) => item.key),
    );
    for (const key of [ACTION_CONTACT_CREATE, ACTION_TASK_UPDATE, ACTION_CONTACT_UPDATE, ACTION_TASK_DEACTIVATE, ACTION_CONTACT_DEACTIVATE]) {
      assert.ok(allKeys.includes(key), `${key} should be a real palette entry`);
    }
  });

  it("Get Records and Loop are both real and addable (Phase 2)", () => {
    const allKeys = Object.values(PALETTE_CATALOG).flatMap((category) =>
      category.items.filter((item) => item.status === "real").map((item) => item.key),
    );
    assert.ok(allKeys.includes(ACTION_GET_RECORDS));
    assert.ok(allKeys.includes(ACTION_LOOP));
  });

  it('no "soon" placeholder is left claiming Get Record/Loop are still unbuilt', () => {
    const soonLabels = Object.values(PALETTE_CATALOG).flatMap((category) =>
      category.items.filter((item) => item.status === "soon").map((item) => item.label),
    );
    assert.ok(!soonLabels.includes("Get Record"));
    assert.ok(!soonLabels.includes("Loop"));
  });

  it("Logic and Records are the only two categories", () => {
    assert.deepEqual(Object.keys(PALETTE_CATALOG).sort(), ["logic", "records"]);
  });
});
