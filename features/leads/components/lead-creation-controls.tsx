"use client";

import { PlusIcon } from "@/features/sales-management/components/icons";
import { CreateLeadDialog } from "./create-lead-dialog";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

type LeadCreationControlsProps = {
  stages: CustomerLeadStage[];
  owners: TeamDirectoryEntry[];
  role: CustomerRole;
  currentUserEmail: string;
};

/**
 * The Pipeline page's own lead-creation entry point: "New Lead" opens
 * CreateLeadDialog blank, exactly as it always has.
 *
 * THIS IS THE ONE PLACE "New Lead" IS EVER VISIBLE. CreateLeadDialog
 * itself no longer hardcodes a trigger button — it takes a
 * `renderTrigger` prop instead (the same pattern AddTaskDialog/
 * NewContactDialog already established), specifically so the AI
 * assistant's globally-mounted launcher can reuse this exact dialog
 * (for its own create_lead intent) WITHOUT also rendering a second
 * "New Lead" button on every page in the app — see
 * assistant-launcher.tsx's own CreateLeadDialog usage, which passes
 * renderTrigger={() => null}. Before renderTrigger existed,
 * CreateLeadDialog's hardcoded button had no way to be suppressed there,
 * which is exactly what put "New Lead" on Contacts/Tasks/Automations/
 * every other page — a real, since-fixed bug, not a design choice.
 *
 * The "Create with AI" button that used to sit next to this one
 * (pasting a transcript/email to pre-fill this same dialog) has been
 * removed from this page's UI. Its underlying pieces — AiLeadCreationEntry
 * (features/leads/components/ai-lead-creation.tsx), extractLeadAction,
 * and extract-lead.ts — are deliberately left in place, unused, rather
 * than deleted, so this can be re-enabled later without rebuilding it.
 * CreateLeadDialog's own `aiPrefill`/`onAiPrefillConsumed` props are
 * simply not passed here any more; they're independent of this removal
 * and still fully exercised by the AI assistant's own "create a lead"
 * chat flow, which mounts its own separate CreateLeadDialog instance.
 */
export function LeadCreationControls({ stages, owners, role, currentUserEmail }: LeadCreationControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <CreateLeadDialog
        stages={stages}
        owners={owners}
        role={role}
        currentUserEmail={currentUserEmail}
        renderTrigger={(open) => (
          <button
            type="button"
            onClick={open}
            className="flex min-h-11 items-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/30 transition-all duration-200 hover:-translate-y-0.5 hover:from-blue-700 hover:to-violet-700 hover:shadow-xl hover:shadow-blue-600/40 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            <PlusIcon className="h-4 w-4 shrink-0" />
            New Lead
          </button>
        )}
      />
    </div>
  );
}
