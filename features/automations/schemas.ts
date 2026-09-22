import { z } from "zod";
import {
  MAX_AI_PROMPT_LENGTH,
  MAX_AUTOMATION_DESCRIPTION_LENGTH,
  MAX_AUTOMATION_NAME_LENGTH,
  MAX_BRANCH_ID_LENGTH,
  MAX_CANVAS_COORDINATE,
  MAX_EDGES_PER_WORKFLOW,
  MAX_NODES_PER_WORKFLOW,
  MAX_NODE_ID_LENGTH,
} from "./config/safeguards";

/**
 * Structural validation for anything that arrives from outside — a form
 * submission, a stored definition being re-read, or a model's JSON.
 *
 * STRUCTURE ONLY. Whether a node's `type` exists and whether its
 * `config` is valid FOR that type is the registry's job, in
 * lib/validate-workflow.ts. Splitting it that way is what lets one
 * validator serve the builder, the save path, the AI output check, test
 * mode and the engine without any of them re-stating the rules.
 *
 * Every bound here is imported from config/safeguards.ts.
 */

export const workflowNodeSchema = z.object({
  id: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  kind: z.enum(["trigger", "condition", "decision", "assignment", "action"]),
  type: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  position: z.object({
    // Finite AND bounded — see MAX_CANVAS_COORDINATE for why both.
    x: z.number().finite().min(-MAX_CANVAS_COORDINATE).max(MAX_CANVAS_COORDINATE),
    y: z.number().finite().min(-MAX_CANVAS_COORDINATE).max(MAX_CANVAS_COORDINATE),
  }),
  // Validated per-type against the registry, not here.
  config: z.record(z.string(), z.unknown()),
});

export const workflowEdgeSchema = z.object({
  id: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  source: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  target: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  // A free string, not a fixed enum — see WorkflowEdge's own note. Which
  // values are actually VALID for a given source node (exactly
  // "true"/"false" for a condition, one of that decision's own outcome
  // ids or "default" for a decision) is a structural fact about THAT
  // node's config, so it is checked in validateWorkflow, not here.
  branch: z.string().trim().min(1).max(MAX_BRANCH_ID_LENGTH).optional(),
});

export const workflowDefinitionSchema = z.object({
  nodes: z.array(workflowNodeSchema).min(1).max(MAX_NODES_PER_WORKFLOW),
  edges: z.array(workflowEdgeSchema).max(MAX_EDGES_PER_WORKFLOW),
});

/**
 * Saving a draft. NOTE WHAT IS ABSENT: no customer_id, no owner_id, no
 * role. All three are resolved server-side from the authenticated
 * session in actions.ts and are not accepted from the client under any
 * name (CLAUDE.md Section G).
 */
export const saveAutomationSchema = z.object({
  automation_id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(MAX_AUTOMATION_NAME_LENGTH),
  description: z.string().trim().max(MAX_AUTOMATION_DESCRIPTION_LENGTH).nullable().default(null),
  definition: workflowDefinitionSchema,
  /**
   * Which builder entry point the admin came through.
   *
   * AN AUDIT HINT, NOT A SECURITY CONTROL, and validated here only so a
   * nonsense value cannot reach the column's CHECK constraint. It is
   * necessarily reported by the client, because only the client knows
   * which of the two entry points the person used — and that is
   * acceptable precisely because nothing reads it: no safeguard, no
   * validation rule, no RLS policy and no branch in the execution
   * engine. Mislabelling it changes one word on a list page in the
   * tenant's own account and nothing else. If it ever gained meaning to
   * the engine, it would have to be derived server-side instead.
   */
  origin: z.enum(["Manual", "AI"]).default("Manual"),
});

export const automationIdSchema = z.object({
  automation_id: z.string().uuid(),
});

export const setAutomationStatusSchema = z.object({
  automation_id: z.string().uuid(),
  // Draft is absent on purpose: an automation returns to Draft by being
  // edited, never by being switched there.
  status: z.enum(["Active", "Inactive"]),
});

export const generateWorkflowSchema = z.object({
  prompt: z.string().trim().min(10).max(MAX_AI_PROMPT_LENGTH),
});

export type SaveAutomationInput = z.infer<typeof saveAutomationSchema>;
