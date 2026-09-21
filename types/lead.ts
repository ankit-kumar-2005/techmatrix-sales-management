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
  /** Which closed stages are WINS. Only ever true alongside is_closed
   *  (CHECK-enforced), and the reason isWonStage() is no longer a name
   *  match — see the stage_probability_and_outcome migration. */
  is_won: boolean;
  /** Whole percentage points, 0-100. Pinned by CHECK to 100 for a won
   *  stage and 0 for any other closed stage; freely admin-configurable
   *  for an open one. Drives every weighted forecast figure. */
  probability: number;
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
  /** Free-text postal address. Added alongside Lead Capture's inbound
   *  webhook ingestion (supabase/migrations/20260919120000) — a
   *  captured lead's address arrives already composed by that source's
   *  own adapter (see features/integrations/lib/providers/), while a
   *  manually-created lead types it straight into this one field. Same
   *  column either way; nothing distinguishes how it was filled in. */
  address: string | null;
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
  /** A human's estimate of when this deal will close — forward-looking,
   *  nullable, and not to be confused with closed_at (which records
   *  when a deal DID close and is server-computed). NULL means "not
   *  forecast yet", which is why an undated open deal counts toward the
   *  Weighted Forecast total but cannot appear in the by-month chart. */
  expected_close_date: string | null;
  created_at: string;
  updated_at: string;
};

/** Row shape returned by the get_customer_team_directory() RPC. */
export type TeamDirectoryEntry = {
  customer_user_id: string;
  user_id: string;
  email: string;
  /** customer_users.name, set at signup (or later invitation, once
   *  that's built) — null for a member with no name on file yet. Never
   *  the primary UI label on its own: see
   *  features/leads/lib/owner-display.ts for how a display label and
   *  initials are derived from this + email. */
  name: string | null;
  role_name: string;
  manager_id: string | null;
  status: string;
};
