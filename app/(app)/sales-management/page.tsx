import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getLeadsForCustomer } from "@/features/leads/lib/get-leads";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { CreateLeadDialog } from "@/features/leads/components/create-lead-dialog";
import { LeadsByStage } from "@/features/leads/components/leads-by-stage";
import { PipelineView } from "@/features/leads/components/pipeline-view";
import { ForecastIcon, PipelineIcon, TargetIcon, TrendingUpIcon } from "@/features/sales-management/components/icons";
import { currencyFormatter } from "@/utils/format";

/**
 * Auth + customer membership are already guarded by
 * app/(app)/layout.tsx before this page ever renders, so this page only
 * fetches what it needs to display — it doesn't repeat the guard.
 * KPIs are computed from the real leads just fetched, not invented — now
 * that `leads.stage` genuinely supports "Lost" (see its CHECK constraint),
 * "Win Rate" is the standard won/(won+lost) rate against decided leads,
 * and "Open Pipeline Value" excludes both Won and Lost (a closed deal,
 * either way, isn't part of the open pipeline).
 */
export default async function SalesManagementPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  const [leads, owners] = await Promise.all([
    // RLS ("hierarchy-aware lead visibility") already restricts this to
    // exactly the leads the caller may see — ADMIN gets the whole
    // customer, everyone else gets their own recursive manager_id
    // branch. No app-level filtering by role is needed here or anywhere
    // else this `leads` array is used (KPIs, Leads by stage, List,
    // Board) — the database query itself already returned only
    // authorized rows.
    getLeadsForCustomer(supabase, membership.customer.id),
    getVisibleTeamDirectory(supabase),
  ]);

  const activeLeads = leads.filter((lead) => lead.status === "Active");
  const openLeads = activeLeads.filter((lead) => lead.stage !== "Won" && lead.stage !== "Lost");
  const qualifiedOrProposal = activeLeads.filter(
    (lead) => lead.stage === "Qualified" || lead.stage === "Proposal",
  );
  const wonLeads = activeLeads.filter((lead) => lead.stage === "Won");
  const lostLeads = activeLeads.filter((lead) => lead.stage === "Lost");

  // deal_value is nullable (NULL = "not provided," distinct from an
  // actual zero) — treated as 0 only for these aggregate sums, never
  // displayed as a fabricated "₹0" anywhere a single lead's own value
  // is shown (see PipelineView's null-safe rendering).
  const sum = (rows: typeof leads) => rows.reduce((total, lead) => total + Number(lead.deal_value ?? 0), 0);

  const decidedLeadCount = wonLeads.length + lostLeads.length;
  const winRate = decidedLeadCount > 0 ? Math.round((wonLeads.length / decidedLeadCount) * 100) : null;
  const avgClosedWonDeal = wonLeads.length > 0 ? sum(wonLeads) / wonLeads.length : null;

  const statCards = [
    {
      label: "Open Pipeline Value",
      value: currencyFormatter.format(sum(openLeads)),
      caption: `${openLeads.length} open lead${openLeads.length === 1 ? "" : "s"}`,
      icon: PipelineIcon,
    },
    {
      label: "Qualified & Proposal Value",
      value: currencyFormatter.format(sum(qualifiedOrProposal)),
      caption: `${qualifiedOrProposal.length} lead${qualifiedOrProposal.length === 1 ? "" : "s"} at that stage`,
      icon: ForecastIcon,
    },
    {
      label: "Win Rate",
      value: winRate === null ? "—" : `${winRate}%`,
      caption: `${wonLeads.length} won · ${lostLeads.length} lost`,
      icon: TargetIcon,
    },
    {
      label: "Avg. Closed-Won Deal",
      value: avgClosedWonDeal === null ? "—" : currencyFormatter.format(avgClosedWonDeal),
      caption: `across ${wonLeads.length} closed-won deal${wonLeads.length === 1 ? "" : "s"}`,
      icon: TrendingUpIcon,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Sales pipeline</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Every open deal for {membership.customer.company_name ?? "your organization"}, in one place.
          </p>
        </div>
        <CreateLeadDialog owners={owners} role={membership.role} currentUserEmail={user.email ?? ""} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{card.label}</p>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-3 text-2xl font-bold text-neutral-900">{card.value}</p>
              <p className="mt-1 text-xs text-neutral-500">{card.caption}</p>
            </div>
          );
        })}
      </div>

      <LeadsByStage leads={leads} />

      <PipelineView leads={leads} owners={owners} />
    </div>
  );
}
