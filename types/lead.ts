import type { RecordStatus } from "./customer";

/**
 * A customer-configured stage from public.customer_lead_stages — there
 * is deliberately no fixed LeadStage union anymore. Stage names are
 * customer-owned data (see the dynamic_lead_stages_and_closed_locking
 * migration); "New"/"Contacted"/etc. are just the default seed rows,
 * never a whitelist the frontend or database enforces.
 */
export type CustomerLeadStage = {
  id: string;
  customer_id: string;
  stage: string;
  display_order: number;
  status: RecordStatus;
  /** The only thing that determines whether a lead in this stage is
   *  locked — never a name comparison like stage === "Won"/"Lost". */
  is_closed: boolean;
  created_at: string;
  updated_at: string;
};

export type Lead = {
  id: string;
  customer_id: string;
  company: string | null;
  contact_name: string;
  email: string | null;
  phone: string | null;
  whatsapp_phone: string | null;
  deal_value: number | null;
  stage_id: string;
  owner_id: string | null;
  source: string | null;
  next_step: string | null;
  status: RecordStatus;
  /** Set automatically (server/trigger-computed) the moment the lead's
   *  stage becomes one where is_closed = true. Non-null means the lead
   *  is locked — see the closed-lead-locking trigger. Never settable or
   *  clearable through a normal update. */
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Row shape returned by the get_customer_team_directory() RPC. */
export type TeamDirectoryEntry = {
  customer_user_id: string;
  user_id: string;
  email: string;
  role_name: string;
  manager_id: string | null;
  status: string;
};
