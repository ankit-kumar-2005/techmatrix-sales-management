import { LEAD_FIELD_REGISTRY, type FieldRegistryEntry } from "./fields";
import { TASK_FIELD_REGISTRY } from "./task-fields";
import { CONTACT_FIELD_REGISTRY } from "./contact-fields";
import type { TriggerObject } from "../lib/plan-workflow";

export const OBJECT_OPTIONS: ReadonlyArray<{ value: TriggerObject; label: string }> = [
  { value: "lead", label: "Lead" },
  { value: "task", label: "Task" },
  { value: "contact", label: "Contact" },
];

/**
 * ONE lookup, reused by Get Records' filter UI/validation instead of a
 * second, hand-maintained field list per object — the exact "reuse the
 * existing field registry per object" the Get Records spec asked for.
 *
 * NOT the same thing as wiring Task/Contact fields into the condition
 * builder (`lead.match`/Decision) — that also needs `evaluateFieldRule`
 * in plan-workflow.ts to know which registry applies to a given
 * condition node, which is a separate, larger change this phase does
 * not make (see docs/automations.md). Get Records' own filter is a NEW,
 * independent evaluator (still `evaluateFieldGroup`, the same AND/OR
 * engine, just called directly against fetched rows rather than
 * through a condition node), so it only ever needed this lookup, not
 * that one.
 */
export function fieldRegistryForObject(object: TriggerObject): ReadonlyArray<FieldRegistryEntry> {
  switch (object) {
    case "task":
      return TASK_FIELD_REGISTRY;
    case "contact":
      return CONTACT_FIELD_REGISTRY;
    default:
      return LEAD_FIELD_REGISTRY;
  }
}
