import type { RecordStatus } from "./customer";

export type LeadStage = "New" | "Contacted" | "Qualified" | "Proposal" | "Won" | "Lost";

export type Lead = {
  id: string;
  customer_id: string;
  company: string | null;
  contact_name: string;
  email: string | null;
  phone: string | null;
  deal_value: number | null;
  stage: LeadStage;
  owner_id: string | null;
  source: string | null;
  next_step: string | null;
  status: RecordStatus;
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
