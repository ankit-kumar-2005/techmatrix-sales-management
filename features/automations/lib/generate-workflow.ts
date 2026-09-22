import { z } from "zod";
import { parseChain, runStructuredCompletion } from "@/lib/ai/openrouter";
import {
  AI_MAX_TOKENS,
  AI_REQUEST_TIMEOUT_MS,
  MAX_ACTIONS_PER_EVENT,
  MAX_AI_QUESTIONS,
  MAX_AI_SUMMARY_LENGTH,
  MAX_AUTOMATION_DESCRIPTION_LENGTH,
  MAX_AUTOMATION_NAME_LENGTH,
  MAX_DUE_DATE_OFFSET_DAYS,
  MAX_NODES_PER_WORKFLOW,
  MAX_NODE_ID_LENGTH,
  MAX_ROUND_ROBIN_POOL,
  MAX_SUBJECT_LENGTH,
} from "../config/safeguards";
import { ACTION_LEAD_UPDATE, CONDITION_FIELD_GROUP, REGISTRY_ENTRIES, SUBJECT_TOKENS, getRegistryEntry } from "../registry/definitions";
import { LEAD_FIELD_REGISTRY, OPERATORS_BY_TYPE } from "../registry/fields";
import { validateWorkflow } from "./validate-workflow";
import type { AiGenerationResult, WorkflowDefinition, WorkflowEdge, WorkflowNode } from "@/types/automation";

/**
 * AI workflow generation.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO PRODUCE. It returns JSON that
 * names `type` keys from the capability registry and fills in a `config`
 * for each. It does not write code, SQL, JavaScript, a URL, a query, an
 * expression, or a template beyond the fixed placeholder tokens the
 * registry already publishes. There is nothing in the pipeline below
 * that evaluates a string, and no field whose value becomes anything
 * other than data compared against a Zod schema.
 *
 * A type key the registry does not contain fails at getRegistryEntry()
 * and the whole generation is refused. That is not a filter bolted on
 * afterwards that has to be kept in sync with the registry — it IS the
 * registry, used as the only lookup there is.
 *
 * THE MODEL NEVER SEES A UUID. Team members are presented as opaque
 * refs ("member_1") paired with a display name, and mapped back to
 * customer_users ids here, server-side, from a directory the caller
 * resolved from its own session. A ref the model invents resolves to
 * nothing and is dropped — it cannot name a person outside the tenant,
 * because the only ids in play were never sent.
 *
 * THE OUTPUT IS ALWAYS A DRAFT. This function returns a definition; it
 * writes nothing. Saving is a separate explicit action, and activation
 * is a third. And whatever comes out of here goes through
 * validateWorkflow() — the identical function a hand-built workflow goes
 * through, with no argument or flag that could soften it.
 */

const DEFAULT_CHAIN = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nex-agi/nex-n2.5-mini:free",
] as const;

/** Positions are assigned here, not by the model — see layOut(). */
const aiNodeSchema = z.object({
  id: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  kind: z.enum(["trigger", "condition", "action"]),
  type: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  config: z.record(z.string(), z.unknown()).default({}),
});

const aiEdgeSchema = z.object({
  source: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  target: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  branch: z.enum(["true", "false"]).nullish(),
});

const aiResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("READY"),
    // The SAME bounds saveAutomationSchema enforces, read from the
    // same constants — a generated name that parsed here and then failed
    // to save would be a draft the admin could not keep.
    name: z.string().trim().min(1).max(MAX_AUTOMATION_NAME_LENGTH),
    description: z.string().trim().max(MAX_AUTOMATION_DESCRIPTION_LENGTH).default(""),
    summary: z.string().trim().min(1).max(MAX_AI_SUMMARY_LENGTH),
    nodes: z.array(aiNodeSchema).min(1).max(MAX_NODES_PER_WORKFLOW),
    edges: z.array(aiEdgeSchema).max(MAX_NODES_PER_WORKFLOW * 2),
  }),
  z.object({
    status: z.literal("NEEDS_CLARIFICATION"),
    questions: z.array(z.string().trim().min(1).max(MAX_AI_SUMMARY_LENGTH)).min(1).max(MAX_AI_QUESTIONS),
  }),
  z.object({
    status: z.literal("UNSUPPORTED"),
    reason: z.string().trim().min(1).max(MAX_AI_SUMMARY_LENGTH),
  }),
]);

export type TeamOption = { ref: string; name: string; customerUserId: string };

/**
 * The system prompt, BUILT FROM THE REGISTRY rather than written out.
 *
 * Every capability, every field, every limitation and every example the
 * model is told about is the same string an admin reads in the palette
 * and the help panel, because both read this one registry. Adding an
 * action teaches the model about it automatically; there is no second
 * document to remember to update, and no way for the prompt to describe
 * a capability that does not exist.
 */
function buildSystemPrompt(team: TeamOption[]): string {
  const capabilities = REGISTRY_ENTRIES.map((entry) => {
    const fields = entry.fields
      .map((field) => {
        const bits = [`      - ${field.name} (${field.kind})${field.required ? " REQUIRED" : ""}: ${field.label}`];
        if (field.options) {
          bits.push(`        one of: ${field.options.map((option) => option.value).join(", ")}`);
        }
        if (typeof field.min === "number" || typeof field.max === "number") {
          bits.push(`        range: ${field.min ?? 0} to ${field.max ?? "unbounded"}`);
        }
        if (field.visibleWhen) {
          bits.push(`        only when ${field.visibleWhen.field} = ${field.visibleWhen.equals}`);
        }
        return bits.join("\n");
      })
      .join("\n");

    return [
      `  ${entry.kind.toUpperCase()} "${entry.key}" — ${entry.label}`,
      `    What it does: ${entry.description}`,
      `    Example: ${entry.example}`,
      `    Cannot: ${entry.limitations.join(" ")}`,
      `    Config fields:`,
      fields,
    ].join("\n");
  }).join("\n\n");

  const roster =
    team.length > 0
      ? team.map((member) => `  ${member.ref} = ${member.name}`).join("\n")
      : "  (nobody is available — if the request needs a named person, answer NEEDS_CLARIFICATION)";

  return `You turn a plain-English description of a sales-automation rule into a
workflow definition for a CRM. You return JSON only.

YOU MAY ONLY USE THE CAPABILITIES LISTED BELOW. You must never invent a
trigger, condition or action type. You must never output code, SQL,
JavaScript, shell commands, URLs, API calls, or database queries. Every
"type" value you emit has to be copied exactly from this list:

${capabilities}

TEAM MEMBERS. Refer to a person ONLY by the reference on the left. Never
output a name, an email or an id in an assignee field.
${roster}

PLACEHOLDERS. In a task subject or description you may use only these:
${SUBJECT_TOKENS.map((token) => `  ${token.token} — ${token.description}`).join("\n")}

FIELD CONDITIONS. For "${CONDITION_FIELD_GROUP}", config is
{"root": <group>} where a <group> is
{"kind":"group","match":"all"|"any","rules":[<rule-or-group>, ...]}
and a rule is
{"kind":"rule","field":"<field key>","operator":"<operator>","value":<value>,"valueTo":null}
("valueTo" only for the "between" operator; otherwise always null).
Only these field keys exist, each with only its own listed operators —
never invent a field key or use an operator not listed for it:
${LEAD_FIELD_REGISTRY.map((field) => `  ${field.key} (${field.type}): ${OPERATORS_BY_TYPE[field.type].join(", ")}`).join("\n")}
Example: deal value over 50000 AND source is IndiaMART —
{"root":{"kind":"group","match":"all","rules":[
{"kind":"rule","field":"deal_value","operator":"greater_than","value":50000,"valueTo":null},
{"kind":"rule","field":"source","operator":"equals","value":"IndiaMART","valueTo":null}]}}

ASSIGNMENT. For any action with an assignmentMode field, set it to
"Fixed" with assigneeRef set to one reference, or "RoundRobin" with
rotationRefs set to a list of references (at most
${MAX_ROUND_ROBIN_POOL}). For "${ACTION_LEAD_UPDATE}" specifically,
assignmentMode may also be "None" to leave the lead's owner unchanged.

LIMITS. At most ${MAX_NODES_PER_WORKFLOW} nodes. At most
${MAX_ACTIONS_PER_EVENT} actions. dueInDays between 0 and
${MAX_DUE_DATE_OFFSET_DAYS}. A task subject is at most
${MAX_SUBJECT_LENGTH} characters.

ANSWER WITH EXACTLY ONE OF THREE SHAPES.

1. The request is clear and every part of it is covered by the
   capabilities above:
   {"status":"READY","name":"...","description":"...","summary":"one or
   two sentences in plain English describing what this will do",
   "nodes":[{"id":"n1","kind":"trigger","type":"lead.created",
   "config":{...}}],"edges":[{"source":"n1","target":"n2"}]}
   Edges leaving a condition MUST set "branch" to "true" or "false".
   Exactly one trigger node. At least one action node. Every node
   reachable from the trigger. No edge may point back to an earlier
   node.

2. The request is missing something you would otherwise have to guess.
   ASK — do not guess. Anything subjective ("urgent", "important",
   "high-value", "a big lead", "hot") is not something you can decide:
   the app has no such field, so you must ask what it should mean in
   terms you have. Also ask when a person is needed and none was named,
   or when "soon"/"later" has no number:
   {"status":"NEEDS_CLARIFICATION","questions":["..."]}

3. The request needs something not in the list above — sending an
   email, a notification, a WhatsApp message, updating a lead, changing
   a stage, waiting for a period of time, anything at all that is not
   listed. Do NOT substitute the nearest thing you do have. Say so:
   {"status":"UNSUPPORTED","reason":"a short explanation of what was
   asked for and that it is not available yet"}

Never mix the shapes. Never add fields. Return only the JSON object.`;
}

export async function generateWorkflow(prompt: string, team: TeamOption[]): Promise<AiGenerationResult> {
  const result = await runStructuredCompletion({
    systemPrompt: buildSystemPrompt(team),
    // The admin's own words, in their own message, never concatenated
    // into the system prompt above.
    userContent: prompt,
    schema: aiResponseSchema,
    chain: parseChain(process.env.OPENROUTER_MODEL_CHAIN, DEFAULT_CHAIN),
    maxTokens: AI_MAX_TOKENS,
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    logLabel: "automations:ai",
  });

  if (!result.ok) {
    return {
      status: "UNSUPPORTED",
      reason:
        result.reason === "not_configured"
          ? "The AI builder is not configured on this deployment. You can still build this on a blank canvas."
          : "The AI builder could not be reached just now. Try again, or build this on a blank canvas.",
    };
  }

  const response = result.value;

  if (response.status === "NEEDS_CLARIFICATION") {
    return { status: "NEEDS_CLARIFICATION", questions: response.questions };
  }

  if (response.status === "UNSUPPORTED") {
    return { status: "UNSUPPORTED", reason: response.reason };
  }

  // ---- Translate the model's shape into a real definition -----------
  const refToId = new Map(team.map((member) => [member.ref, member.customerUserId]));
  const nodes: WorkflowNode[] = [];

  for (const node of response.nodes) {
    const entry = getRegistryEntry(node.type);
    if (!entry) {
      // THE MECHANISM, not a filter: an unknown type has nothing to look
      // up, so there is nothing to run and the whole generation is
      // refused rather than partially salvaged.
      return {
        status: "UNSUPPORTED",
        reason: `The suggested workflow used "${node.type}", which this app cannot do. Nothing has been saved.`,
      };
    }
    if (entry.kind !== node.kind) {
      return {
        status: "UNSUPPORTED",
        reason: "The suggested workflow placed a step in the wrong position. Nothing has been saved.",
      };
    }

    nodes.push({
      id: node.id,
      kind: node.kind,
      type: node.type,
      position: { x: 0, y: 0 },
      config: translateConfig(node.config, refToId),
    });
  }

  const edges: WorkflowEdge[] = response.edges.map((edge, index) => ({
    id: `e${index + 1}`,
    source: edge.source,
    target: edge.target,
    ...(edge.branch ? { branch: edge.branch } : {}),
  }));

  const definition: WorkflowDefinition = { nodes: layOut(nodes, edges), edges };

  // ---- THE SAME GATE A HAND-BUILT WORKFLOW PASSES -------------------
  const validation = validateWorkflow(definition);
  if (!validation.ok) {
    return {
      status: "UNSUPPORTED",
      reason:
        "The suggested workflow did not pass validation, so it has not been offered as a draft. " +
        `Problems found: ${validation.issues
          .map((issue) => issue.message)
          .slice(0, 3)
          .join("; ")}`,
    };
  }

  return {
    status: "READY",
    name: response.name,
    description: response.description,
    definition,
    summary: response.summary,
  };
}

/**
 * Maps the model's opaque member refs onto real customer_users ids, and
 * leaves every other key untouched for the registry's own schema to
 * judge.
 *
 * An unrecognised ref becomes null rather than being passed through: the
 * assignee fields are typed as UUIDs by the registry schema, so a
 * hallucinated "member_9" would fail validation with a confusing
 * message instead of the clear "pick who this should be assigned to"
 * that a null produces.
 */
function translateConfig(config: Record<string, unknown>, refToId: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };

  if ("assigneeRef" in out) {
    const ref = out.assigneeRef;
    out.assigneeId = typeof ref === "string" ? (refToId.get(ref) ?? null) : null;
    delete out.assigneeRef;
  }

  if ("rotationRefs" in out) {
    const refs = Array.isArray(out.rotationRefs) ? out.rotationRefs : [];
    out.rotation = refs
      .filter((ref): ref is string => typeof ref === "string")
      .map((ref) => refToId.get(ref))
      .filter((id): id is string => typeof id === "string");
    delete out.rotationRefs;
  }

  return out;
}

/**
 * Assigns canvas coordinates by graph depth.
 *
 * The model is not asked for positions at all — they carry no meaning it
 * could know, and asking for two extra numbers per node is two more ways
 * for a response to be unusable. Laying them out here means a generated
 * workflow opens in the builder looking like a hand-built one: trigger
 * at the left, each following step one column to the right, siblings
 * stacked.
 */
function layOut(nodes: WorkflowNode[], edges: ReadonlyArray<{ source: string; target: string }>): WorkflowNode[] {
  const COLUMN_WIDTH = 280;
  const ROW_HEIGHT = 150;

  const depth = new Map<string, number>();
  const trigger = nodes.find((node) => node.kind === "trigger");
  if (trigger) {
    depth.set(trigger.id, 0);
    const queue = [trigger.id];
    // Bounded by the node count: a cycle would otherwise spin here, and
    // validateWorkflow() has not run yet at this point.
    let guard = nodes.length * 2;
    while (queue.length > 0 && guard-- > 0) {
      const current = queue.shift() as string;
      const currentDepth = depth.get(current) ?? 0;
      for (const edge of edges) {
        if (edge.source !== current) continue;
        const existing = depth.get(edge.target);
        if (existing === undefined || existing < currentDepth + 1) {
          depth.set(edge.target, currentDepth + 1);
          queue.push(edge.target);
        }
      }
    }
  }

  const usedRows = new Map<number, number>();

  return nodes.map((node) => {
    const column = depth.get(node.id) ?? 0;
    const row = usedRows.get(column) ?? 0;
    usedRows.set(column, row + 1);
    return { ...node, position: { x: column * COLUMN_WIDTH, y: row * ROW_HEIGHT } };
  });
}

/** Builds the opaque refs the model is given, from a directory the
 *  caller already resolved from its own session. Only Active members,
 *  because an inactive one cannot be assigned a task anyway and offering
 *  them would produce a draft that fails at execution. */
export function buildTeamOptions(
  directory: ReadonlyArray<{ customer_user_id: string; name: string | null; email: string; status: string }>,
): TeamOption[] {
  return directory
    .filter((member) => member.status === "Active")
    .slice(0, MAX_ROUND_ROBIN_POOL)
    .map((member, index) => ({
      ref: `member_${index + 1}`,
      // The display name if there is one, else the local part of the
      // email — never the full email, which would put an address in a
      // third-party prompt for no benefit.
      name: member.name?.trim() || member.email.split("@")[0],
      customerUserId: member.customer_user_id,
    }));
}
