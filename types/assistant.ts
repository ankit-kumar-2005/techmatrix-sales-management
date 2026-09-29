/**
 * The AI assistant's core response shape — one call, one of two
 * outcomes, adapted from the feature spec's own template to this app's
 * three real object types (Lead/Task/Contact) and their real required
 * fields (see features/assistant/lib/classify-intent.ts's own header
 * for the full Phase 0 reasoning behind every field below).
 *
 * WHY ONE FLAT `fields` BAG rather than a per-intent discriminated
 * shape: `status` is the one discriminant Zod's discriminatedUnion can
 * cleanly key on (NEEDS_CLARIFICATION carries no `fields` at all, only
 * `questions`); `intent` still varies which of `fields`' keys are
 * actually meaningful for a given response, but that's a plain
 * `switch (intent)` in code, not a second schema-level discriminant.
 * A flat, mostly-optional bag is a few unused keys per intent — a much
 * smaller cost than a triple-nested union, and every value in it still
 * goes through the same anti-hallucination Zod validation regardless
 * of which keys a given intent actually reads.
 */
export type AssistantIntent =
  | "create_lead"
  | "create_task"
  | "create_contact"
  | "edit_lead"
  | "edit_task"
  | "edit_contact"
  | "summarize"
  | "unclear";

/**
 * Every field the model can ever populate, across every intent —
 * always null unless clearly stated (see classify-intent.ts's system
 * prompt). Which of these are read for a given response is entirely
 * determined by `intent`; the rest are ignored, never written anywhere.
 *
 * NEVER: customer_id, owner_id, assigned_to, stage_id, lead_id as a
 * literal value, or any other id — the model never sees or produces a
 * database id. `assignee_name`/`object` are the two fields that name
 * something OTHER than the record's own data (a person, an object
 * type) and are handled specially by code, never trusted as-is (see
 * resolve-reference.ts and classify-intent.ts).
 */
export type AssistantFields = {
  // Lead (create_lead / edit_lead)
  contact_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  deal_value: number | null;
  source: string | null;
  next_step: string | null;
  /** edit_lead ONLY — the target pipeline stage's real NAME as the user
   *  said it ("Qualified", "Won"), NEVER an id (the model never sees
   *  one). Resolved against this customer's REAL, current Active stages
   *  in code (actions.ts, reusing resolve-reference.ts's own
   *  fuzzy-match-or-ask mechanism — the same one record_reference
   *  already goes through), never trusted as a stage_id itself. Added
   *  specifically so a spoken stage change ("move this to Qualified")
   *  has somewhere to land — before this field existed, the assistant
   *  had no way to represent a stage change at all. */
  stage: string | null;
  // Task (create_task / edit_task)
  subject: string | null;
  description: string | null;
  priority: string | null;
  due_date: string | null;
  type: string | null;
  /** A literal name as written in the message, e.g. "assign it to
   *  Priya" — NEVER a database id, the same rule Meeting Notes'
   *  suggested_assignee already follows. Resolved against the caller's
   *  own visible team directory in code, and even then only ever
   *  becomes a non-binding UI hint (TaskFormFields' own assigneeHint),
   *  never the actual assigned_to value — see classify-intent.ts. */
  assignee_name: string | null;
  // Contact (create_contact / edit_contact) — reuses name/company/
  // email/phone above; contacts has no separate fields of its own
  // besides `title`.
  title: string | null;
  // Summarize
  /** Which object type to summarize — only meaningful when
   *  intent === "summarize". */
  object: "lead" | "task" | "contact" | null;
};

export type AssistantResponse =
  | {
      status: "NEEDS_CLARIFICATION";
      intent: AssistantIntent;
      questions: string[];
      /** The model's best-effort partial guess at which record is being
       *  discussed, kept even on a clarification response so the next
       *  turn (which includes full history regardless) has continuity.
       *  Never trusted as a resolved id — always re-run through
       *  resolve-reference.ts. */
      record_reference: string | null;
    }
  | {
      status: "READY";
      intent: AssistantIntent;
      record_reference: string | null;
      /** True when the user identified the record ONLY with a bare
       *  pronoun or vague back-reference ("this", "that", "it", "that
       *  lead", "the one you just showed me") and named nothing else
       *  identifying in the same message — record_reference is then
       *  null, and the caller resolves this against LastReferencedRecord
       *  (real conversation state, not something the model can see or
       *  produce itself) instead of matching text against the record
       *  set. The model's only job here is the language judgment
       *  ("is this a back-reference at all") — which record it actually
       *  points to is resolved deterministically in code. */
      refers_to_last_discussed: boolean;
      fields: AssistantFields;
    };

/**
 * The one piece of conversation state beyond plain message history —
 * held client-side alongside `messages` (never persisted, reset by
 * "New chat", exactly like history itself), updated by the server
 * action's own result after each turn. Set only when the most recent
 * exchange was unambiguously ABOUT exactly one record (a single-record
 * summary, an edit that was opened, a create that resolved to one
 * linked lead) — a bulk/list result (e.g. "summarize my leads" showing
 * several) clears it back to null, because a subsequent "this" is
 * genuinely ambiguous at that point, not resolvable to one of several.
 */
export type LastReferencedRecord = { type: "lead" | "task" | "contact"; id: string; label: string } | null;

/**
 * A compact, clickable option shown in the chat for a record a
 * "summarize"/lookup request resolved to (one match, or a short list —
 * see actions.ts's own summarize branch). Clicking one calls
 * getRecordDetailAction, which builds the fuller, LABELED-FIELD
 * summary deterministically (features/assistant/lib/format-summary.ts)
 * — no LLM involved in that step at all, which is what makes the
 * currency/stage-name bugs structurally impossible to reintroduce
 * here: there's nothing left to invent a value or a symbol, only real
 * fields being read and labeled.
 */
export type AssistantRecordCard = { type: "lead" | "task" | "contact"; id: string; label: string };

/**
 * One labeled row on a confirmation card (AssistantPendingAction below).
 * `value` is always already display-formatted (a real stage name, ₹
 * currency, a real date) — never a raw id or an unformatted number, the
 * same rule format-summary.ts's own fields already follow.
 *
 * `previousValue`, when present, means this row is an EDIT's before →
 * after diff (rendered as "Label: previousValue → value"); when absent,
 * it's a plain CREATE field (rendered as "Label: value"). An edit field
 * that ISN'T actually changing is simply never included as a row at all
 * — see AssistantPendingAction's own doc comment.
 */
export type AssistantPendingActionField = { label: string; value: string; previousValue?: string };

export type AssistantPendingActionKind = "create_lead" | "create_task" | "create_contact" | "edit_lead" | "edit_task" | "edit_contact";

/**
 * An inline confirmation card rendered directly in the chat thread —
 * what a create/edit turn produces INSTEAD OF immediately opening the
 * real dialog (see actions.ts's own header on this: replacing WHERE
 * confirmation is shown, never weakening WHAT counts as confirmation).
 *
 * THE ONE INVARIANT THAT MUST NEVER BREAK: `payload` is built entirely
 * from data already resolved and validated in actions.ts (real ids,
 * real stage names turned into real stage ids, the record's own
 * existing values for anything the user didn't mention) — never raw,
 * unvalidated model text passed straight through. Clicking Confirm
 * calls confirmAssistantActionAction(kind, payload), which does nothing
 * but hand `payload` to the exact same createLeadAction/updateLeadAction/
 * createTaskAction/updateTaskAction/createContactAction/
 * updateContactAction the real dialog's own Save button already calls —
 * same schema, same auth, same RLS, same everything. A typed "yes" or
 * "confirm" chat message can NEVER reach this: classifyIntent has no
 * concept of "there's a pending card" and confirmAssistantActionAction
 * has exactly one caller in this whole codebase — the card's own
 * Confirm button's onClick.
 */
export type AssistantPendingAction = {
  kind: AssistantPendingActionKind;
  /** Card heading — e.g. "New Lead", "Update Kiran Pande". */
  title: string;
  /** CREATE: every field that will be saved. EDIT: ONLY the fields
   *  actually different from the record's current values (each with
   *  `previousValue` set) — never empty; an edit that resolved with
   *  nothing actually different falls back to opening the real dialog
   *  directly instead of reaching this type at all (see actions.ts). */
  fields: AssistantPendingActionField[];
  /** The exact FormData (as plain string entries) this card's Confirm
   *  button submits — see this type's own header. */
  payload: Record<string, string>;
  /** "Edit instead" opens this — the exact same real dialog/prefill
   *  this feature already builds, completely unchanged. */
  editFallback: AssistantFormTrigger;
};

/**
 * Tells the chat panel exactly which existing dialog to open, and with
 * what — the ONLY thing a "READY, act on it" turn ever produces
 * besides its own reply text. Every variant carries either a create-mode
 * prefill (reused verbatim by CreateLeadDialog/AddTaskDialog/
 * NewContactDialog's own aiPrefill props) or a full, already-merged
 * record for one of the three real Edit dialogs — never anything a
 * dialog doesn't already know how to render, and never anything that
 * saves on its own (non-negotiable #1: opening a form is not a write).
 */
export type AssistantFormTrigger =
  | { type: "create_lead"; prefill: import("@/features/leads/components/lead-form-fields").LeadFormDefaultValues }
  | {
      type: "create_task";
      prefill: import("@/features/tasks/components/task-form-fields").TaskFormPrefill;
      defaultLead: { id: string; label: string };
      assigneeHint?: import("@/features/tasks/components/task-form-fields").TaskAssigneeHint;
    }
  | {
      type: "create_contact";
      prefill: import("@/features/contacts/components/contact-form-fields").ContactFormPrefill;
      defaultLead: { id: string; label: string };
    }
  | { type: "edit_lead"; lead: import("@/features/leads/lib/get-leads").PipelineLead }
  | { type: "edit_task"; task: import("./task").Task; lockedLeadLabel: string }
  | { type: "edit_contact"; contact: import("@/features/contacts/lib/get-contacts").ContactListItem; lockedLeadLabel: string };

/** One turn in the assistant's own conversation — client-side only,
 *  never persisted (non-negotiable #5). role "user" covers typed,
 *  pasted, AND transcribed-from-voice text identically — by the time a
 *  message becomes one of these, its input method is already forgotten,
 *  which is the whole point (voice is just an alternate way to produce
 *  text, never a separate reasoning path). */
export type AssistantMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };
