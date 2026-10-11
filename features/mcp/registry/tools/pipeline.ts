import { z } from "zod";
import { getForecastByStage, getForecastSummary } from "@/features/forecast/lib/get-forecast";
import { money } from "../../lib/output";
import type { McpToolDefinition } from "../types";

/**
 * Reuses the Forecast page's own RPC wrappers. The RPCs are SECURITY
 * INVOKER, so "hierarchy-aware lead visibility" is evaluated inside them
 * for the caller — a Rep's summary covers only their own deals, a
 * Manager's their team's, an Admin's the company's, exactly like Forecast.
 */
const pipelineSummaryInput = z.object({});

export const getPipelineSummary: McpToolDefinition<z.infer<typeof pipelineSummaryInput>> = {
  name: "get_pipeline_summary",
  label: "Pipeline summary",
  summary: "Stage counts, open value and the weighted forecast.",
  description:
    "Summarize the pipeline this person can see: open deal count, best case, probability-weighted forecast, closed-won value, " +
    "what is expected to close this month, and a per-stage breakdown. Amounts are in INR.",
  group: "Pipeline",
  kind: "read",
  capability: "read",
  idempotent: false,
  inputSchema: pipelineSummaryInput,
  outputFields: ["currency", "summary", "stages"],
  async handler(context) {
    const [summary, stages] = await Promise.all([
      getForecastSummary(context.supabase),
      getForecastByStage(context.supabase),
    ]);

    const amount = (value: number) => {
      const m = money(value);
      return { value: m.value, formatted: m.formatted };
    };

    return {
      data: {
        currency: "INR",
        summary: {
          open_deal_count: summary.openDealCount,
          best_case: amount(summary.bestCase),
          weighted_forecast: amount(summary.weightedForecast),
          closed_won_value: amount(summary.closedWonValue),
          closed_won_count: summary.closedWonCount,
          expected_this_month_value: amount(summary.expectedThisMonthValue),
          expected_this_month_count: summary.expectedThisMonthCount,
          open_deals_without_close_date: summary.undatedOpenCount,
        },
        stages: stages.map((row) => ({
          stage: row.stage,
          is_closed: row.isClosed,
          is_won: row.isWon,
          probability_percent: row.probability,
          open_deal_count: row.openDealCount,
          total_value: amount(row.totalValue),
          weighted_value: amount(row.weightedValue),
        })),
      },
      recordIds: [],
    };
  },
};
