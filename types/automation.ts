/**
 * Shared automation types. Row shapes mirror the tables created in
 * supabase/migrations/20260921120000_automations.sql; the workflow graph
 * types mirror what the registry and Zod schemas accept.
 */

export type AutomationStatus = "Draft" | "Active" | "Inactive";

/**
 * How an automation came to exist. RECORDED FOR HISTORY, READ BY NOTHING
 * THAT RUNS. No safeguard, no validation rule, no policy and no branch
 * in the execution engine consults this value — an AI-authored workflow
 * and a hand-built one are the same row to every line of code that runs
 * after activation.
 */
export type AutomationOrigin = "Manual" | "AI";

export type AutomationEventStatus = "pending" | "processing" | "succeeded" | "failed" | "dead";

export type AutomationRunStatus = "succeeded" | "failed" | "skipped" | "stopped_by_safeguard";

/**
 * "decision" and "assignment" both branch/act like "condition" and
 * "action" always did — a Decision is a condition with more than two
 * named outputs instead of a fixed yes/no, and an Assignment is a
 * pass-through step (one input, one output, no branch) that sets a
 * workflow variable rather than writing to the database. Neither is a
 * new WALK MECHANISM, just a generalisation of the two that already
 * existed — see plan-workflow.ts.
 */
export type AutomationNodeKind = "trigger" | "condition" | "decision" | "assignment" | "action";

/** One node on the canvas. `config` is validated against the registry
 *  entry named by `type` — never executed, never interpreted as code. */
export type WorkflowNode = {
  id: string;
  kind: AutomationNodeKind;
  /** A registry key, e.g. "lead.created" or "task.create". */
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  /**
   * Set on edges leaving a branching node (condition or decision):
   * which output this edge is. A condition's branch is always "true" or
   * "false"; a decision's branch is one of its own outcome ids, or the
   * fixed string "default" for the otherwise path. Generalised from a
   * two-value enum to any string for exactly that reason — see
   * MAX_BRANCH_ID_LENGTH.
   */
  branch?: string;
};

/** The whole graph, as stored in customer_automation_versions.definition. */
export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type AutomationListItem = {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  origin: AutomationOrigin;
  active_version_id: string | null;
  created_at: string;
  updated_at: string;
  /** Highest version number that exists, active or not. */
  latest_version: number;
  /** Null until the automation has run at least once. */
  last_run_at: string | null;
  last_run_status: AutomationRunStatus | null;
};

export type AutomationVersionRow = {
  id: string;
  automation_id: string;
  version: number;
  trigger_type: string;
  definition: WorkflowDefinition;
  created_at: string;
};

export type AutomationDetail = {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  origin: AutomationOrigin;
  active_version_id: string | null;
  created_at: string;
  updated_at: string;
  /** Newest first. */
  versions: AutomationVersionRow[];
};

export type AutomationRunListItem = {
  id: string;
  automation_id: string;
  automation_name: string;
  version: number;
  status: AutomationRunStatus;
  stop_reason: string | null;
  error_detail: string | null;
  actions_executed: number;
  started_at: string;
  finished_at: string | null;
};

/** One problem found by validation, addressed to a specific node where
 *  one is to blame. */
export type ValidationIssue = {
  /** Null for issues about the workflow as a whole. */
  nodeId: string | null;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

/**
 * What the AI builder returns, before a human has saved anything.
 *
 * Three outcomes rather than two, because "I can't do that" and "I need
 * you to tell me more" call for completely different things from the
 * person reading them, and collapsing them would mean guessing on their
 * behalf — which is the one thing this must never do.
 */
export type AiGenerationResult =
  | { status: "READY"; name: string; description: string; definition: WorkflowDefinition; summary: string }
  | { status: "NEEDS_CLARIFICATION"; questions: string[] }
  | { status: "UNSUPPORTED"; reason: string };
