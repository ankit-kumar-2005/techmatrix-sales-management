import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { CompanyInformationForm } from "@/features/customers/components/company-information-form";

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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Company Information</h1>
        <p className="mt-1 text-sm text-neutral-600">
          {membership.isPrimaryAdmin
            ? "View and update your company's details."
            : "View your company's details. Only the Primary Admin can make changes."}
        </p>
      </div>

      <div className="max-w-2xl rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
        <CompanyInformationForm customer={membership.customer} canEdit={membership.isPrimaryAdmin} />
      </div>
    </div>
  );
}
