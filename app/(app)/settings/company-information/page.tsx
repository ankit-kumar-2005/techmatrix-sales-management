import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { CompanyInformationForm } from "@/features/customers/components/company-information-form";
import { LeadStageSettings } from "@/features/leads/components/lead-stage-settings";
import { getLeadStagesForCustomer } from "@/features/leads/lib/get-lead-stages";

export default async function CompanyInformationPage() {
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

  const stages = await getLeadStagesForCustomer(supabase, membership.customer.id);

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Company Information</h1>
          <p className="mt-1.5 text-sm text-neutral-500">
            {membership.isPrimaryAdmin
              ? "View and update your company's details."
              : "View your company's details. Only the Primary Admin can make changes."}
          </p>
        </div>
        {/* Purely decorative — hidden below xl: rather than shrunk, so it
            never competes with the title/subtitle or the form for room. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- a static local SVG; next/image would need images.dangerouslyAllowSVG configured project-wide just for this one decorative asset */}
        <img
          src="/illustrations/working.svg"
          alt=""
          aria-hidden="true"
          className="hidden w-60 shrink-0 select-none xl:block"
        />
      </div>

      <CompanyInformationForm customer={membership.customer} canEdit={membership.isPrimaryAdmin} />

      <LeadStageSettings stages={stages} canConfigure={membership.role === "ADMIN"} />
    </div>
  );
}
