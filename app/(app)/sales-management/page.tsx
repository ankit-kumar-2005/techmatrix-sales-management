import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getLeadsForCustomer } from "@/features/leads/lib/get-leads";
import { getLeadStagesForCustomer } from "@/features/leads/lib/get-lead-stages";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { CreateLeadDialog } from "@/features/leads/components/create-lead-dialog";
import { KpiCards, type KpiCardData } from "@/features/leads/components/kpi-cards";
import { LeadsByStage } from "@/features/leads/components/leads-by-stage";
import { PipelineView } from "@/features/leads/components/pipeline-view";
import { isWonStage } from "@/features/leads/lib/stage-colors";
import { ForecastIcon, PipelineIcon, TargetIcon, TrendingUpIcon } from "@/features/sales-management/components/icons";

/**
 * Auth + customer membership are already guarded by
 * app/(app)/layout.tsx before this page ever renders, so this page only
 * fetches what it needs to display — it doesn't repeat the guard.
 *
 * Stages are customer-configured data (public.customer_lead_stages), not
 * a fixed list. Most of this page's KPIs are computed from each lead's
 * *resolved* is_closed flag alone, never from a stage's name: "Open
 * Pipeline Value" is "not in a closed stage," full stop.
 *
 * Win Rate / Avg. Closed-Won Deal are the one exception — see
 * isWonStage's own doc comment in features/leads/lib/stage-colors.ts for
 * why (no is_won column exists) and what the fallback is. Imported from
 * there, not redefined here, so the Pipeline's colors and these two KPI
 * numbers can never disagree about which closed leads count as "won."
 */
export default async function SalesManagementPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  const [leads, stages, owners] = await Promise.all([
    // RLS ("hierarchy-aware lead visibility") already restricts this to
    // exactly the leads the caller may see — ADMIN gets the whole
    // customer, everyone else gets their own recursive manager_id
    // branch. No app-level filtering by role is needed here or anywhere
    // else this `leads` array is used (KPIs, Leads by stage, List,
    // Board) — the database query itself already returned only
    // authorized rows.
    getLeadsForCustomer(supabase, membership.customer.id),
    getLeadStagesForCustomer(supabase, membership.customer.id),
    getVisibleTeamDirectory(supabase),
  ]);

  const activeStages = stages.filter((stage) => stage.status === "Active");
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));

  const activeLeads = leads.filter((lead) => lead.status === "Active");
  const openLeads = activeLeads.filter((lead) => !stagesById.get(lead.stage_id)?.is_closed);
  const closedLeads = activeLeads.filter((lead) => stagesById.get(lead.stage_id)?.is_closed);
  const wonLeads = closedLeads.filter((lead) => isWonStage(stagesById.get(lead.stage_id)));
  const lostLeads = closedLeads.filter((lead) => !isWonStage(stagesById.get(lead.stage_id)));
  const qualifiedOrProposalLeads = activeLeads.filter((lead) => {
    const stage = stagesById.get(lead.stage_id);
    return stage && !stage.is_closed && (stage.stage === "Qualified" || stage.stage === "Proposal");
  });

  // deal_value is nullable (NULL = "not provided," distinct from an
  // actual zero) — treated as 0 only for these aggregate sums, never
  // displayed as a fabricated "₹0" anywhere a single lead's own value
  // is shown (see PipelineView's null-safe rendering).
  const sum = (rows: typeof leads) => rows.reduce((total, lead) => total + Number(lead.deal_value ?? 0), 0);

  const decidedLeadCount = wonLeads.length + lostLeads.length;
  const winRate = decidedLeadCount > 0 ? Math.round((wonLeads.length / decidedLeadCount) * 100) : null;
  const avgClosedWonDeal = wonLeads.length > 0 ? sum(wonLeads) / wonLeads.length : null;

  // One accent per card — blue for the primary/anchor card, matching the
  // blue -> violet gradient now used for the sidebar's active nav item
  // and the New Lead button, so the page's "primary" color thread is
  // consistent everywhere it appears. violet/emerald/amber for the other
  // three. Icons are rendered here (not passed as bare component
  // references) because KpiCards is a Client Component receiving these
  // as props from this Server Component — only rendered elements, not
  // component values, can cross that boundary. Kept out of
  // stage-colors.ts on purpose: these are page-level KPI accents, not
  // stage identities — nothing here is derived from any stage's name or
  // display_order.
  const statCards: KpiCardData[] = [
    {
      label: "Open Pipeline Value",
      value: sum(openLeads),
      format: "currency",
      caption: `${openLeads.length} open lead${openLeads.length === 1 ? "" : "s"}`,
      icon: <PipelineIcon className="h-4.5 w-4.5" />,
      accent: {
        gradient: "from-white to-blue-50",
        gradientHover: "hover:to-blue-100",
        iconBg: "bg-blue-50 group-hover:bg-blue-100",
        iconText: "text-blue-600",
        iconRing: "ring-blue-100",
        iconGlow: "shadow-md shadow-blue-200/70",
      },
    },
    {
      label: "Qualified & Proposal Value",
      value: sum(qualifiedOrProposalLeads),
      format: "currency",
      caption: `${qualifiedOrProposalLeads.length} lead${qualifiedOrProposalLeads.length === 1 ? "" : "s"} at that stage`,
      icon: <ForecastIcon className="h-4.5 w-4.5" />,
      accent: {
        gradient: "from-white to-violet-50",
        gradientHover: "hover:to-violet-100",
        iconBg: "bg-violet-50 group-hover:bg-violet-100",
        iconText: "text-violet-600",
        iconRing: "ring-violet-100",
        iconGlow: "shadow-md shadow-violet-200/70",
      },
    },
    {
      label: "Win Rate",
      value: winRate,
      format: "percent",
      caption: `${wonLeads.length} won · ${lostLeads.length} lost`,
      icon: <TargetIcon className="h-4.5 w-4.5" />,
      accent: {
        gradient: "from-white to-emerald-50",
        gradientHover: "hover:to-emerald-100",
        iconBg: "bg-emerald-50 group-hover:bg-emerald-100",
        iconText: "text-emerald-600",
        iconRing: "ring-emerald-100",
        iconGlow: "shadow-md shadow-emerald-200/70",
      },
    },
    {
      label: "Avg. Closed-Won Deal",
      value: avgClosedWonDeal,
      format: "currency",
      caption: `across ${wonLeads.length} closed-won deal${wonLeads.length === 1 ? "" : "s"}`,
      icon: <TrendingUpIcon className="h-4.5 w-4.5" />,
      accent: {
        gradient: "from-white to-amber-50",
        gradientHover: "hover:to-amber-100",
        iconBg: "bg-amber-50 group-hover:bg-amber-100",
        iconText: "text-amber-600",
        iconRing: "ring-amber-100",
        iconGlow: "shadow-md shadow-amber-200/70",
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Sales Pipeline</h1>
          <span
            aria-hidden="true"
            className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
          />
          <p className="mt-1.5 text-sm text-neutral-500">
            Every open deal for {membership.customer.company_name ?? "your organization"}, in one place.
          </p>
        </div>
        <CreateLeadDialog
          stages={activeStages}
          owners={owners}
          role={membership.role}
          currentUserEmail={user.email ?? ""}
        />
      </div>

      <KpiCards cards={statCards} />

      <LeadsByStage leads={leads} stages={stages} />

      <PipelineView
        leads={leads}
        stages={stages}
        owners={owners}
        role={membership.role}
        currentUserEmail={user.email ?? ""}
        currentUserCustomerUserId={membership.membership.id}
      />
    </div>
  );
}
