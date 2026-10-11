import { z } from "zod";
import { BRAND_NAME } from "@/lib/brand";
import type { DomainWriteResult } from "@/types/customer";
import type { CustomerLeadStage } from "@/types/lead";
import { isRealIsoDate } from "@/utils/iso-date";
import { getLeadStagesForCustomer } from "@/features/leads/lib/get-lead-stages";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { getLeadLabelsByIds } from "@/features/leads/lib/get-lead-labels";
import { MCP_IDEMPOTENCY_KEY_MAX_LENGTH, MCP_IDEMPOTENCY_KEY_MIN_LENGTH } from "../../config/limits";
import { McpToolError, invalidInput, notFound, type McpErrorCode } from "../../lib/errors";
import type { ProjectionLookups } from "../../lib/output";
import type { McpToolContext } from "../types";

export const recordId = (label: string) => z.string().uuid(`${label} must be a record id.`);

export const isoDate = (label: string) =>
  z.string().refine(isRealIsoDate, { message: `${label} must be a date in YYYY-MM-DD format.` });

/** Who to assign a record to. NOT the caller's identity — the caller is
 *  always the token's owner. This is a business field, authorized exactly
 *  as in the UI: the domain service and RLS decide whether it is honoured
 *  (a non-admin's lead is always their own; a task/contact assignee must
 *  be inside the caller's visible hierarchy). */
export const assigneeId = () =>
  z
    .string()
    .uuid("assignee_id must be a team member's id.")
    .optional()
    .describe("Team member to assign to (customer user id from a previous result). Defaults to you.");

export const idempotencyKey = () =>
  z
    .string()
    .min(MCP_IDEMPOTENCY_KEY_MIN_LENGTH)
    .max(MCP_IDEMPOTENCY_KEY_MAX_LENGTH)
    .regex(/^[A-Za-z0-9_.:-]+$/, "idempotency_key may only contain letters, digits and _ . : -")
    .optional()
    .describe("Optional. Send the same key when retrying so the record is created only once.");

/** Zod field errors (from the app's own form schemas) as one sentence. */
export function fieldErrorsMessage(fieldErrors: Record<string, string>): string {
  return Object.entries(fieldErrors)
    .map(([field, message]) => `${field}: ${message}`)
    .join(" ");
}

/**
 * A domain service result as an MCP outcome. not_found is always the
 * generic message, so a hidden record and a missing one read the same.
 * `failedCode` lets each tool say what an RLS refusal most likely means
 * for it (e.g. "forbidden" for an assignee outside the hierarchy).
 */
export function unwrapDomainResult(result: DomainWriteResult, failedCode: McpErrorCode = "internal_error"): string | null {
  if (result.ok) return result.id;
  switch (result.kind) {
    case "invalid":
      throw invalidInput(fieldErrorsMessage(result.fieldErrors));
    case "not_found":
      throw notFound();
    case "forbidden":
      throw new McpToolError("forbidden", result.message);
    case "conflict":
      throw new McpToolError("conflict", result.message);
    case "failed":
      throw new McpToolError(failedCode, result.message);
  }
}

export function findStageByName(stages: CustomerLeadStage[], name: string): CustomerLeadStage | undefined {
  const wanted = name.trim().toLowerCase();
  return stages.find((stage) => stage.stage.trim().toLowerCase() === wanted);
}

/** New leads with no stage named go to the first Active, open stage in
 *  the company's own order — the top of their pipeline. */
export function defaultStage(stages: CustomerLeadStage[]): CustomerLeadStage | undefined {
  return [...stages]
    .filter((stage) => stage.status === "Active" && !stage.is_closed)
    .sort((a, b) => a.display_order - b.display_order)[0];
}

export function unknownStage(stages: CustomerLeadStage[]): McpToolError {
  const names = stages.filter((stage) => stage.status === "Active").map((stage) => stage.stage);
  return invalidInput(`Unknown stage. Your stages are: ${names.join(", ")}.`);
}

export async function loadLookups(
  context: McpToolContext,
  needs: { stages?: boolean; people?: boolean; leadIds?: string[] },
): Promise<ProjectionLookups & { stages: CustomerLeadStage[] }> {
  const { supabase, actor } = context;
  const [stages, people, labels] = await Promise.all([
    needs.stages ? getLeadStagesForCustomer(supabase, actor.customerId) : Promise.resolve([] as CustomerLeadStage[]),
    needs.people ? getVisibleTeamDirectory(supabase) : Promise.resolve([]),
    needs.leadIds && needs.leadIds.length > 0
      ? getLeadLabelsByIds(supabase, actor.customerId, [...new Set(needs.leadIds)])
      : Promise.resolve([]),
  ]);

  return {
    stages,
    stagesById: new Map(stages.map((stage) => [stage.id, stage])),
    peopleById: new Map(people.map((person) => [person.customer_user_id, person])),
    leadLabelsById: new Map(labels.map((label) => [label.id, label])),
  };
}

/** Awaits a builder that has been through applyConditions (typed
 *  structurally there) and returns PostgREST's result shape. */
export function runQuery(query: unknown): PromiseLike<{ data: unknown; error: unknown }> {
  return query as PromiseLike<{ data: unknown; error: unknown }>;
}

/** A read query failed for a reason other than RLS — never forward the
 *  database's own text. */
export function readFailed(): McpToolError {
  return new McpToolError("internal_error", `${BRAND_NAME} could not complete this request. Please try again.`);
}
