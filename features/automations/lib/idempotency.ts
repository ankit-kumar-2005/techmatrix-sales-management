/**
 * The idempotency key a task created by an automation carries.
 *
 * DETERMINISTIC BY CONSTRUCTION — every input is an identifier that was
 * already fixed before the work started, so a retry of the same event by
 * a different worker, minutes later, computes the same string
 * character-for-character. Nothing here reads a clock, a counter or a
 * random source; if it did, a retry would produce a new key and the
 * unique index would let the duplicate through, which is the exact
 * failure this exists to prevent.
 *
 * WHY ALL FOUR PARTS:
 *   automationId  two automations reacting to the same lead must each
 *                 be able to create their own task
 *   version       a workflow edited between the first attempt and a
 *                 later one is a different intention, and should not be
 *                 suppressed as a duplicate of the old one
 *   eventId       the actual unit of delivery being made idempotent
 *   nodeId        one workflow may hold several task.create nodes on
 *                 different branches
 *
 * Paired with tasks_automation_key_unique, the partial unique index on
 * (customer_id, automation_key) — and deliberately not scoped by
 * customer here, because that index already is. Adding the tenant to
 * the string as well would be a second, weaker copy of a guarantee the
 * database is already making.
 */
export function buildAutomationKey(params: {
  automationId: string;
  version: number;
  eventId: string;
  nodeId: string;
}): string {
  return `a:${params.automationId}:v${params.version}:e:${params.eventId}:n:${params.nodeId}`;
}
