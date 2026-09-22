import {
  ACTION_CONTACT_CREATE,
  ACTION_CONTACT_DEACTIVATE,
  ACTION_CONTACT_UPDATE,
  ACTION_GET_RECORDS,
  ACTION_LEAD_DEACTIVATE,
  ACTION_LOOP,
  ACTION_TASK_CREATE,
  ACTION_TASK_DEACTIVATE,
  ACTION_TASK_UPDATE,
  ASSIGNMENT_SET_VARIABLE,
  DECISION_MULTI_OUTCOME,
} from "./definitions";

/**
 * WHAT THE "+" PALETTE AND THE CANVAS INSERTION MENU OFFER — ONE LIST,
 * so the sidebar and the contextual popover can never disagree about
 * what exists to add.
 *
 * A Salesforce-style Logic/Records split, by explicit request — but
 * unlike `getEntriesByKind`, this is a curated ALLOWLIST rather than
 * "every registered entry of this kind". That is a deliberate exception
 * to "the registry is the menu", used for two different reasons that
 * must not be confused with each other:
 *
 *   1. CONSOLIDATION, not hiding. `lead.source.is`, `lead.has_owner` and
 *      `lead.match` are real, tested, unchanged registry entries — they
 *      stay exactly as they are for any workflow already using them.
 *      They simply no longer have their OWN separate palette entry,
 *      because Decision (`lead.decision`) can already express everything
 *      each of them does (and more) through the identical AND/OR field
 *      engine underneath. Confirmed as a pure UI change: no schema or
 *      evaluator code changed to make this true.
 *   2. A DELIBERATE, TEMPORARY SCOPE CHOICE. Update Lead (`lead.update`)
 *      has no add-from-palette entry point for now, by explicit request
 *      — real and backed, just not offered here yet.
 *
 * Nothing about a hidden entry's own registry entry, executor, or an
 * EXISTING node of that type already on a canvas changes either way —
 * this only controls whether the palette offers a way to add a NEW one.
 *
 * Update Task/Contact and Delete (deactivate) Task/Contact became REAL
 * here in the same phase that built 20260923120000_task_contact_
 * automation_writes.sql and its node-reference targeting — each one is
 * a fully working entry, verified against real PostgreSQL (see
 * test/db/review5-task-contact.mjs), not a placeholder promoted early.
 *
 * Get Records and Loop became REAL in the Phase 2 expansion that added
 * get_automation_records (tenant-scoped the same way every write
 * function already is — see that migration's own design notes) and
 * record/collection variables. Get Records does NOT use the
 * node-output-binding mechanism this file used to say Loop and Get
 * Record both still needed — it sidesteps that need entirely by writing
 * its result into a NAMED VARIABLE at EXECUTION time (not planWorkflow,
 * which is pure and cannot query the database), which Loop then reads
 * by that same name. See registry/executors.ts's own extensive notes on
 * exactly how that composes with MAX_ACTIONS_PER_EVENT, and
 * docs/automations.md for the stated v1 limitations of both (Get
 * Records searches only the most recent MAX_RECORDS_PER_QUERY rows;
 * Loop's body is exactly one step, not a sequence).
 *
 * "soon" ITEMS ARE NEVER A SECOND REGISTRY. Each carries only a label
 * and a plain-English reason — no key, no config, nothing a picker
 * could accidentally wire up to `onAdd`.
 */

export type PaletteRealItem = { status: "real"; key: string };
export type PaletteSoonItem = { status: "soon"; label: string; description: string };
export type PaletteItem = PaletteRealItem | PaletteSoonItem;

export type PaletteCategory = "logic" | "records";

export const PALETTE_CATALOG: Record<PaletteCategory, { title: string; blurb: string; items: PaletteItem[] }> = {
  logic: {
    title: "Logic",
    blurb: "Branch the workflow, prepare a value, or repeat a step over a set of records.",
    items: [
      { status: "real", key: DECISION_MULTI_OUTCOME },
      { status: "real", key: ASSIGNMENT_SET_VARIABLE },
      { status: "real", key: ACTION_LOOP },
    ],
  },
  records: {
    title: "Records",
    blurb: "Create, change, or search a Lead, Task, or Contact.",
    items: [
      { status: "real", key: ACTION_TASK_CREATE },
      { status: "real", key: ACTION_CONTACT_CREATE },
      { status: "real", key: ACTION_TASK_UPDATE },
      { status: "real", key: ACTION_CONTACT_UPDATE },
      { status: "real", key: ACTION_TASK_DEACTIVATE },
      { status: "real", key: ACTION_CONTACT_DEACTIVATE },
      { status: "real", key: ACTION_LEAD_DEACTIVATE },
      { status: "real", key: ACTION_GET_RECORDS },
    ],
  },
};
