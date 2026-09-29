"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { CreateLeadDialog } from "@/features/leads/components/create-lead-dialog";
import { EditLeadDialog } from "@/features/leads/components/edit-lead-dialog";
import { AddTaskDialog } from "@/features/tasks/components/add-task-dialog";
import { EditTaskDialog } from "@/features/tasks/components/edit-task-dialog";
import { NewContactDialog } from "@/features/contacts/components/new-contact-dialog";
import { EditContactDialog } from "@/features/contacts/components/edit-contact-dialog";
import { CheckIcon, CloseIcon, CopyIcon, MicrophoneIcon, RefreshIcon, SendIcon } from "@/features/sales-management/components/icons";
import { confirmAssistantActionAction, getRecordDetailAction, sendAssistantMessageAction } from "../actions";
import { ASSISTANT_MESSAGE_MAX_LENGTH } from "../schemas";
import { useVoiceRecorder } from "./use-voice-recorder";
import { useGreetingVoice } from "./use-greeting-voice";
import { BRAND_MARK_HEIGHT, BRAND_MARK_SRC, BRAND_MARK_WIDTH, BRAND_NAME } from "@/lib/brand";
import { formatRelativeTime } from "@/utils/format";
import type { LeadFormDefaultValues } from "@/features/leads/components/lead-form-fields";
import type { TaskFormPrefill, TaskAssigneeHint } from "@/features/tasks/components/task-form-fields";
import type { ContactFormPrefill } from "@/features/contacts/components/contact-form-fields";
import type { PipelineLead } from "@/features/leads/lib/get-leads";
import type { ContactListItem } from "@/features/contacts/lib/get-contacts";
import type { Task } from "@/types/task";
import type {
  AssistantFormTrigger,
  AssistantMessage,
  AssistantPendingAction,
  AssistantRecordCard,
  LastReferencedRecord,
} from "@/types/assistant";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

/** Whether an inline confirmation card is still awaiting a click, or has
 *  already been resolved one way or the other — once resolved, its
 *  Confirm/Cancel/"Edit instead" buttons are replaced by a plain status
 *  line so a past card in the scrollback can never be clicked twice. */
type PendingActionStatus = "pending" | "confirmed" | "cancelled";

/** A plain AssistantMessage (what's sent back to the server as
 *  history), plus several things the server side never persists: the
 *  clickable record-card options a "summarize"/lookup turn resolved
 *  to (see AssistantRecordCard's own doc comment), an inline
 *  create/edit confirmation card (see AssistantPendingAction's own
 *  doc comment), when this turn was created (for the action row's own
 *  relative timestamp), and — for a message that can safely be
 *  regenerated — a closure that redoes exactly the request that
 *  produced it (see the action row's own doc comment for which message
 *  types get one and why).
 *
 * `regenerate` IS A FUNCTION, WHICH MUST NEVER REACH sendAssistantMessageAction.
 * A function reference can't survive Next.js's Server Action argument
 * serialization — see toHistoryPayload() below, which strips every
 * field on this type down to the plain {role, content} the server
 * actually needs, for every call site that sends `messages` as history. */
type DisplayMessage = AssistantMessage & {
  recordCards?: AssistantRecordCard[];
  pendingAction?: AssistantPendingAction;
  pendingActionStatus?: PendingActionStatus;
  createdAt: number;
  regenerate?: () => void;
};

/** The ONLY shape sendAssistantMessageAction's `history` parameter ever
 *  actually needs — see DisplayMessage's own doc comment on why this
 *  exists (never pass `messages` to a Server Action directly). */
function toHistoryPayload(msgs: DisplayMessage[]): AssistantMessage[] {
  return msgs.map(({ role, content }) => ({ role, content }));
}

type AssistantLauncherProps = {
  stages: CustomerLeadStage[];
  teamDirectory: TeamDirectoryEntry[];
  role: CustomerRole;
  currentUserEmail: string;
  currentUserCustomerUserId: string;
  /** customer_users.name — the same field the Profile page's own
   *  "Name" row reads (see app/(app)/layout.tsx's own comment on this
   *  prop). Null for a member who never set one; buildGreeting below
   *  falls back to their email in that case. */
  currentUserName: string | null;
};

/** A few short, warm openers — never the identical line every time,
 *  matching this feature's own "creative, warm wording... not a stiff
 *  template" brief. Time-of-day is real (from the caller's own clock,
 *  not guessed), the specific variant is picked at random each time the
 *  panel opens or "New chat" is clicked — see callers below. */
function buildGreeting(name: string): string {
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const variants = [
    `${timeOfDay}, ${name}! I'm Pipeway, your sales assistant — what can I help with today?`,
    `Hey ${name} — Pipeway here. Ready when you are: a lead, a task, a quick summary, anything.`,
    `${timeOfDay}, ${name}. I'm here for your leads, tasks, and contacts — where should we start?`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

/** Per-browser, client-side only — NOT a database column (there is
 *  nothing per-tenant or per-account about "has this browser ever
 *  opened the assistant"; it's a UI nicety, the exact same category as
 *  AppShell's own sidebar-collapse preference, which is why this reuses
 *  that same localStorage pattern rather than adding schema for it). */
const HAS_OPENED_STORAGE_KEY = "pipeway-assistant-has-opened";

/** Four real capabilities, not four variations of one thing — a
 *  create, a bulk summary, an edit (the stage-change flow), and a
 *  filtered lookup — so the chips actually demonstrate the range of
 *  what this assistant can do. Clicking one sends this EXACT text
 *  through the normal sendMessage path, same as if it had been typed. */
const SUGGESTION_PROMPTS = [
  "Create a lead for Rohan Desai at Desai Interiors, phone 98765 43210",
  "Summarize my leads from this week",
  "Change the stage of the Twin Energy lead to Qualified",
  "Show me my overdue tasks",
];

/**
 * The floating launcher + chat panel — the ONLY new piece of UI this
 * feature adds. Mounted once, globally (see app/(app)/layout.tsx), so
 * it's available from every authenticated page, the same way the
 * reference screenshots' own widget is always present regardless of
 * which page you're on. Inspired ONLY by that reference's launcher
 * PLACEMENT (a small floating button, bottom corner, opening a panel) —
 * no avatar, no video, no persona; a plain chat bubble icon and this
 * app's own existing gradient/card/button language throughout.
 *
 * OWNS EXACTLY ONE THING THAT MATTERS FOR SAFETY: which of the six
 * existing Create/Edit dialogs is currently mounted, and what it's
 * pre-filled with. It never calls a create/update Server Action
 * itself — every one of those six dialogs is the exact same component
 * (and the exact same createXAction/updateXAction) manual entry
 * already uses; this component only decides WHEN one of them opens and
 * WHAT its aiPrefill/defaultValues starts with. Saving is still, in
 * every case, an explicit click inside that dialog.
 *
 * EDIT DIALOGS ARE MOUNTED INDEPENDENTLY of PipelineView/TaskList/
 * ContactList (which normally own them) — this component fetches the
 * one record being edited itself (via sendAssistantMessageAction's own
 * resolution, server-side) and mounts EditLeadDialog/EditTaskDialog/
 * EditContactDialog directly with it, exactly as those dialogs already
 * expect (a record + onClose). Zero changes were needed to those three
 * list pages to make this possible.
 */
export function AssistantLauncher({
  stages,
  teamDirectory,
  role,
  currentUserEmail,
  currentUserCustomerUserId,
  currentUserName,
}: AssistantLauncherProps) {
  // The real logged-in user's name (falling back to their email when
  // none is on file) — same disambiguation rule owner/assignee labels
  // already use elsewhere (features/leads/lib/owner-display.ts), reused
  // here rather than invented fresh: "name if set, else the identity
  // that's always there."
  const displayName = currentUserName?.trim() || currentUserEmail;

  const [isOpen, setIsOpen] = useState(false);
  const [greeting, setGreeting] = useState(() => buildGreeting(displayName));
  const [greetingCreatedAt, setGreetingCreatedAt] = useState(() => Date.now());
  // Which message's action row triggered the speech currently playing —
  // "greeting" for the opening greeting, or String(index) for an entry
  // in `messages`. Only meaningful paired with the voice hook's own
  // (global) isSpeaking: a row shows itself as active only when BOTH
  // isSpeaking is true AND its own key matches this. Deliberately never
  // reset back to null on its own (no effect syncing it) — once
  // isSpeaking goes false, every row's active check is false regardless
  // of what this still points at, so there is nothing to clean up.
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  // Ticks while the panel is open so every action row's relative
  // timestamp ("just now" -> "2 minutes ago") actually advances instead
  // of freezing at whatever it read on first render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Defaults to true (assume first-time until localStorage says
  // otherwise) — the safe direction to fail in if storage is blocked:
  // an extra bit of onboarding is harmless, quietly skipping it for a
  // genuine first-timer isn't. Read back on mount, same hydration-safe
  // pattern as HAS_OPENED_STORAGE_KEY's own doc comment describes.
  const [isFirstOpenEver, setIsFirstOpenEver] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Which card (if any) is mid-fetch — disables just that one button so
  // a double-click can't fire two detail requests, without blocking the
  // rest of the chat.
  const [loadingCardId, setLoadingCardId] = useState<string | null>(null);
  // Which MESSAGE's inline confirmation card is mid-submit (index into
  // `messages`) — while set, every pending card's own buttons disable,
  // so two confirms can never race each other.
  const [submittingIndex, setSubmittingIndex] = useState<number | null>(null);

  const [leadPrefill, setLeadPrefill] = useState<LeadFormDefaultValues | null>(null);
  const [taskPrefill, setTaskPrefill] = useState<{
    prefill?: TaskFormPrefill;
    defaultLead?: { id: string; label: string };
    assigneeHint?: TaskAssigneeHint;
  } | null>(null);
  const [contactPrefill, setContactPrefill] = useState<{
    prefill?: ContactFormPrefill;
    defaultLead?: { id: string; label: string };
  } | null>(null);

  const [editingLead, setEditingLead] = useState<PipelineLead | null>(null);
  const [editingTask, setEditingTask] = useState<{ task: Task; lockedLeadLabel: string } | null>(null);
  const [editingContact, setEditingContact] = useState<{ contact: ContactListItem; lockedLeadLabel: string } | null>(null);

  // Real conversation state beyond plain message history — see
  // LastReferencedRecord's own doc comment. Held here, alongside
  // `messages`, for the identical reason: client-only, never
  // persisted, reset by "New chat". Threaded into every
  // sendAssistantMessageAction call so "edit this" can resolve against
  // whichever single record the conversation most recently,
  // unambiguously showed — see that action's own header for why this
  // is real tracked state, not something asked of the model itself.
  const [lastReferencedRecord, setLastReferencedRecord] = useState<LastReferencedRecord>(null);

  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  // Only ticks while the panel is actually visible — nobody can see a
  // stale "3 minutes ago" while it's closed, so there's no reason to
  // keep re-rendering a hidden component every 30 seconds. Restarting
  // on every open also means timestamps are always freshly correct the
  // moment someone looks at them again.
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    try {
      const hasOpenedBefore = window.localStorage.getItem(HAS_OPENED_STORAGE_KEY) === "true";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- window/localStorage don't exist during SSR; syncing a persisted UI preference once on mount is the same hydration-safe pattern AppShell's own sidebar-collapse preference already uses
      setIsFirstOpenEver(!hasOpenedBefore);
    } catch {
      // Private mode / disabled storage — stays "first open" every
      // time, which just means always showing the fuller onboarding
      // treatment rather than silently under-informing a real newcomer.
    }
  }, []);

  function applyFormTrigger(trigger: AssistantFormTrigger) {
    switch (trigger.type) {
      case "create_lead":
        setLeadPrefill(trigger.prefill);
        break;
      case "create_task":
        setTaskPrefill({ prefill: trigger.prefill, defaultLead: trigger.defaultLead, assigneeHint: trigger.assigneeHint });
        break;
      case "create_contact":
        setContactPrefill({ prefill: trigger.prefill, defaultLead: trigger.defaultLead });
        break;
      case "edit_lead":
        setEditingLead(trigger.lead);
        break;
      case "edit_task":
        setEditingTask({ task: trigger.task, lockedLeadLabel: trigger.lockedLeadLabel });
        break;
      case "edit_contact":
        setEditingContact({ contact: trigger.contact, lockedLeadLabel: trigger.lockedLeadLabel });
        break;
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;

    const historySnapshot = messages;
    const referenceSnapshot = lastReferencedRecord;
    setMessages((prev) => [...prev, { role: "user", content: trimmed, createdAt: Date.now() }]);
    setInputValue("");
    setIsSending(true);
    setVoiceError(null);

    // Regenerating this exact reply later just means: re-run this exact
    // call again. A closure (not stored data) is what makes "the exact
    // same request" trivially true — it captures `trimmed` as it was
    // typed/sent, not a snapshot that could drift; it never touches
    // `messages`/`lastReferencedRecord` as they stand NOW, only as they
    // stood at the moment this specific reply was produced would be
    // wrong anyway — a regenerate is a fresh ask, same words, current
    // context, exactly like retyping it.
    const regenerate = () => void sendMessage(trimmed);

    try {
      const result = await sendAssistantMessageAction(toHistoryPayload(historySnapshot), trimmed, referenceSnapshot);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.reply,
          createdAt: Date.now(),
          recordCards: result.recordCards,
          pendingAction: result.pendingAction,
          pendingActionStatus: result.pendingAction ? "pending" : undefined,
          regenerate,
        },
      ]);
      if (result.formTrigger) {
        applyFormTrigger(result.formTrigger);
      }
      // Omitted entirely (undefined) means "leave it alone" — see
      // AssistantTurnResult's own doc comment on why that's a real,
      // deliberate third state and not the same as null.
      if (result.lastReferencedRecord !== undefined) {
        setLastReferencedRecord(result.lastReferencedRecord);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Something went wrong sending that. Please try again.",
          createdAt: Date.now(),
          regenerate,
        },
      ]);
    } finally {
      setIsSending(false);
    }
  }

  /**
   * The click side of the record-card feature: turns one clicked
   * AssistantRecordCard into its full, deterministic, labeled-field
   * summary (getRecordDetailAction — no LLM involved, see that
   * action's own header). Appended as a brand-new assistant message,
   * exactly like any other reply, so the chat keeps reading top to
   * bottom as one conversation.
   */
  async function handleCardClick(card: AssistantRecordCard) {
    if (loadingCardId) return;
    setLoadingCardId(card.id);
    // Re-clicking the same card re-runs this exact lookup — a fresh
    // read through the same deterministic, RLS-respecting fetch, never
    // a database write, so there's nothing "already saved" this could
    // ever conflict with.
    const regenerate = () => void handleCardClick(card);
    try {
      const result = await getRecordDetailAction(card.type, card.id);
      if (result.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: result.summary, createdAt: Date.now(), regenerate }]);
        setLastReferencedRecord(result.lastReferencedRecord);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: result.reply, createdAt: Date.now(), regenerate }]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Something went wrong loading that. Please try again.", createdAt: Date.now(), regenerate },
      ]);
    } finally {
      setLoadingCardId(null);
    }
  }

  function updateMessageAt(index: number, patch: Partial<DisplayMessage>) {
    setMessages((prev) => prev.map((message, i) => (i === index ? { ...message, ...patch } : message)));
  }

  /**
   * The Confirm button's ONLY job: hand `pendingAction.kind`/`.payload`
   * straight to confirmAssistantActionAction — the exact same
   * createLeadAction/updateLeadAction/createTaskAction/updateTaskAction/
   * createContactAction/updateContactAction the real dialog's own Save
   * button already calls (see that action's own header). This function
   * never validates, authorizes, or writes anything itself; it only
   * relays a button click and then renders whatever that one real
   * action decided. `pendingAction.fields`' own LABELS (never their
   * values) are passed through so a successful edit's reply can name
   * exactly what changed — see confirmAssistantActionAction's own
   * changedFieldLabels parameter.
   */
  async function handleConfirmPendingAction(index: number, pendingAction: AssistantPendingAction) {
    if (submittingIndex !== null) return;
    setSubmittingIndex(index);
    try {
      const result = await confirmAssistantActionAction(
        pendingAction.kind,
        pendingAction.payload,
        pendingAction.fields.map((field) => field.label),
      );
      if (result.success) {
        updateMessageAt(index, { pendingActionStatus: "confirmed" });
      }
      // NEVER a regenerate closure here — see the action row's own doc
      // comment. A successful result.message states something already
      // written to the database (a real create/update); "regenerating"
      // it would read as redoing a save that already happened. A failed
      // result already has its own real retry — the card's own Confirm
      // button, still live since the card stays "pending" on failure —
      // so a second, different-feeling retry mechanism here would only
      // invite confusion about which one to use.
      setMessages((prev) => [...prev, { role: "assistant", content: result.message, createdAt: Date.now() }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Something went wrong saving that. Please try again.", createdAt: Date.now() },
      ]);
    } finally {
      setSubmittingIndex(null);
    }
  }

  /** Cancel never calls the server at all — there is nothing to undo
   *  because nothing was ever written; this only marks the card
   *  resolved so its buttons can't be clicked again. */
  function handleCancelPendingAction(index: number) {
    updateMessageAt(index, { pendingActionStatus: "cancelled" });
    // No regenerate here either — there is nothing to redo; this is a
    // plain statement that nothing happened, not a result of a request
    // that could be re-run for a different outcome.
    setMessages((prev) => [...prev, { role: "assistant", content: "Cancelled — nothing was saved.", createdAt: Date.now() }]);
  }

  /** Opens the exact same real dialog this card's own Confirm button
   *  would otherwise submit to, pre-filled with the identical proposed
   *  values — for anyone who wants to change something beyond what the
   *  card already summarized. Resolves the card (so it can't also be
   *  confirmed afterward) without pretending anything was saved. */
  function handleEditInsteadPendingAction(index: number, pendingAction: AssistantPendingAction) {
    updateMessageAt(index, { pendingActionStatus: "cancelled" });
    applyFormTrigger(pendingAction.editFallback);
  }

  const voice = useVoiceRecorder({
    onError: (message) => setVoiceError(message),
  });

  // Greeting speech is entirely separate from voice INPUT above — see
  // use-greeting-voice.ts's own header for why this hook only ever
  // speaks a string it's explicitly handed, never anything it reads or
  // writes itself. Now backs BOTH the automatic greeting and every
  // message action row's own manual "speak" button (see
  // handleSpeakMessage below).
  const { voiceEnabled, toggleVoiceEnabled, isSpeaking, speak, stopSpeaking } = useGreetingVoice();

  /**
   * One message's own "speak" button. Deliberately calls speak()
   * unconditionally — never gated on `voiceEnabled` — because clicking
   * THIS is an explicit, one-off request to hear THIS specific message,
   * independent of the separate auto-greeting mute setting (see
   * use-greeting-voice.ts's own header). Clicking the SAME message's
   * button again while it's already the one playing stops it instead of
   * restarting it; clicking a DIFFERENT message's button stops whatever
   * was playing and starts the new one — speak() itself already cancels
   * any in-flight utterance before starting a new one, so two messages
   * can never talk over each other either way.
   */
  function handleSpeakMessage(key: string, text: string) {
    if (speakingKey === key && isSpeaking) {
      stopSpeaking();
      return;
    }
    setSpeakingKey(key);
    speak(text);
  }

  /** The review panel's own Send button — hands off to the EXACT same
   *  send path typed text already uses (non-negotiable #6). Recording
   *  finishing never sends anything by itself; only this explicit click
   *  does. */
  function confirmVoiceMessage() {
    const text = voice.confirmReview();
    void sendMessage(text);
  }

  /**
   * A fresh greeting, shown AND spoken. `speak()` is called directly
   * here — never from a useEffect — because both callers below (the
   * launcher button's own onClick, and "New chat"'s own onClick) are
   * themselves direct user gestures, and calling speechSynthesis
   * synchronously inside that same handler is what keeps browsers from
   * treating it as unrequested autoplay. See use-greeting-voice.ts's own
   * header for the full reasoning.
   *
   * THE MUTE CHECK LIVES HERE, NOT INSIDE speak() ITSELF: speak() now
   * always speaks when called, because the per-message speak button
   * below deliberately must NOT respect this same toggle. The automatic
   * greeting is the one caller that should stay mutable-around, so it's
   * the one caller that checks `voiceEnabled` before ever calling speak().
   */
  function greetAnew() {
    const text = buildGreeting(displayName);
    setGreeting(text);
    setGreetingCreatedAt(Date.now());
    if (voiceEnabled) {
      speak(text);
    }
  }

  function startNewChat() {
    setMessages([]);
    setInputValue("");
    setVoiceError(null);
    setLeadPrefill(null);
    setTaskPrefill(null);
    setContactPrefill(null);
    setEditingLead(null);
    setEditingTask(null);
    setEditingContact(null);
    setLastReferencedRecord(null);
    greetAnew();
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    void sendMessage(inputValue);
  }

  /** The onboarding card's (or the quiet repeat-open row's) "Paste Text"
   *  affordance — never a second input mode or a separate extraction
   *  pipeline, just a focus nudge toward the ONE textarea that's always
   *  there, whose own placeholder already invites exactly this ("Type a
   *  request, or paste a transcript..."). Whatever ends up pasted there
   *  goes through the exact same sendMessage -> classifyIntent path any
   *  typed message already does. */
  function focusPasteText() {
    textareaRef.current?.focus();
  }

  /** Opens (or closes) the panel — greeting only fires on the OPENING
   *  click, never on close, and never a second time just from a
   *  re-render. `isOpen` here is this render's own current value, read
   *  directly rather than through setIsOpen's functional-update form,
   *  so greetAnew() (a real side effect: it also calls speechSynthesis)
   *  never runs from inside a state updater. */
  function handleLauncherClick() {
    const opening = !isOpen;
    setIsOpen(opening);
    if (opening) {
      greetAnew();
      if (isFirstOpenEver) {
        // Flips to the "quiet" repeat-open treatment from the very
        // next open onward — even later in this same session, not
        // just after a future page load.
        setIsFirstOpenEver(false);
        try {
          window.localStorage.setItem(HAS_OPENED_STORAGE_KEY, "true");
        } catch {
          // Preference just won't persist across reloads — not worth
          // surfacing an error for a non-critical UI nicety.
        }
      }
    }
  }

  return (
    <>
      <div className="fixed right-6 bottom-6 z-[1000]">
        {!isOpen ? (
          <span
            aria-hidden="true"
            className="absolute inset-0 -z-10 animate-ping rounded-full bg-violet-500/50 [animation-duration:2.5s]"
          />
        ) : null}
        <button
          type="button"
          onClick={handleLauncherClick}
          aria-label={isOpen ? "Close assistant" : "Open assistant"}
          className={`relative flex items-center justify-center rounded-full bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 text-white shadow-lg shadow-violet-600/30 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-violet-600/40 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:ring-offset-2 focus-visible:outline-none ${
            isOpen ? "h-14 w-14" : "h-14 gap-2 px-5"
          }`}
        >
          {isOpen ? (
            <CloseIcon className="h-6 w-6" />
          ) : (
            <>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white p-1 shadow-sm">
                <PipewayMark size={16} />
              </span>
              <span className="text-sm font-semibold whitespace-nowrap">Ask Pipeway</span>
            </>
          )}
        </button>
      </div>

      {isOpen ? (
        <div className="fixed right-6 bottom-24 z-[1000] flex h-[min(44rem,calc(100vh-8rem))] w-[calc(100vw-3rem)] max-w-md flex-col overflow-hidden rounded-3xl bg-white shadow-[0_24px_70px_-18px_rgba(79,70,229,0.45)] ring-1 ring-black/5">
          <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 px-4 py-3.5">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-10 -right-8 h-32 w-32 rounded-full bg-white/10 blur-2xl"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-12 -left-6 h-28 w-28 rounded-full bg-sky-300/20 blur-2xl"
            />
            <div className="relative flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 text-white">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white p-1.5 shadow-sm ring-1 ring-white/40">
                  <PipewayMark size={24} />
                </span>
                <div className="flex flex-col leading-tight">
                  <span className="text-sm font-semibold">Pipeway Assistant</span>
                  <span className="flex items-center gap-1 text-[11px] font-medium text-white/75">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                    AI-powered · Always on
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={toggleVoiceEnabled}
                  aria-label={voiceEnabled ? "Mute assistant voice" : "Unmute assistant voice"}
                  aria-pressed={voiceEnabled}
                  title={voiceEnabled ? "Voice greeting on — click to mute" : "Voice greeting muted — click to unmute"}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 hover:text-white"
                >
                  <SpeakerIcon muted={!voiceEnabled} className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={startNewChat}
                  className="rounded-full px-2.5 py-1 text-xs font-semibold text-white/90 transition-colors hover:bg-white/15 hover:text-white"
                >
                  New chat
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 hover:text-white"
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto bg-gradient-to-b from-sky-50/50 via-white to-white px-4 py-3.5">
            <div className="flex flex-col gap-3">
              <AssistantBubble role="assistant">{greeting}</AssistantBubble>
              <MessageActionRow
                text={greeting}
                createdAt={greetingCreatedAt}
                nowMs={nowMs}
                isSpeaking={speakingKey === "greeting" && isSpeaking}
                onSpeak={() => handleSpeakMessage("greeting", greeting)}
                onRegenerate={greetAnew}
              />
              {speakingKey === "greeting" && isSpeaking ? (
                <p role="status" className="flex items-center gap-1.5 pl-8 text-xs font-medium text-violet-500">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
                  </span>
                  Speaking...
                </p>
              ) : null}
              {isFirstOpenEver && messages.length === 0 ? (
                <div className="flex flex-col gap-2.5 pl-8">
                  <button
                    type="button"
                    onClick={focusPasteText}
                    className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-gradient-to-br from-sky-50 to-violet-50 p-3.5 text-left shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 text-base">
                      📋
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-semibold text-neutral-800">Paste Text</span>
                      <span className="text-xs leading-relaxed text-neutral-500">
                        Paste anything — a call transcript, an email, or notes — and I&rsquo;ll pull out the details.
                      </span>
                    </span>
                  </button>

                  <p className="text-xs font-semibold text-neutral-400">Or try asking me things like:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTION_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => void sendMessage(prompt)}
                        className="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-left text-xs leading-relaxed text-neutral-700 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 hover:shadow-md"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {messages.map((turn, index) => (
                <div key={index} className="flex flex-col gap-1.5">
                  <AssistantBubble role={turn.role}>{turn.content}</AssistantBubble>
                  {turn.role === "assistant" ? (
                    <MessageActionRow
                      text={turn.content}
                      createdAt={turn.createdAt}
                      nowMs={nowMs}
                      isSpeaking={speakingKey === String(index) && isSpeaking}
                      onSpeak={() => handleSpeakMessage(String(index), turn.content)}
                      onRegenerate={turn.regenerate}
                    />
                  ) : null}
                  {turn.recordCards && turn.recordCards.length > 0 ? (
                    <div className="flex flex-col items-start gap-1.5 pl-8">
                      {turn.recordCards.map((card) => (
                        <button
                          key={card.id}
                          type="button"
                          onClick={() => handleCardClick(card)}
                          disabled={loadingCardId !== null}
                          className="group flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3.5 py-2 text-left text-sm font-medium text-neutral-800 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
                        >
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500 text-[10px] font-bold text-white">
                            {card.label.trim().charAt(0).toUpperCase() || "•"}
                          </span>
                          {loadingCardId === card.id ? "Loading..." : card.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {turn.pendingAction ? (
                    <div className="pl-8">
                      <PendingActionCard
                        pendingAction={turn.pendingAction}
                        status={turn.pendingActionStatus ?? "pending"}
                        busy={submittingIndex !== null}
                        pending={submittingIndex === index}
                        onConfirm={() => handleConfirmPendingAction(index, turn.pendingAction!)}
                        onCancel={() => handleCancelPendingAction(index)}
                        onEditInstead={() => handleEditInsteadPendingAction(index, turn.pendingAction!)}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
              {isSending ? (
                <AssistantBubble role="assistant">
                  <span className="inline-flex items-center gap-1.5 py-0.5">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-br from-blue-500 to-violet-500 [animation-delay:-0.3s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-br from-blue-500 to-violet-500 [animation-delay:-0.15s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-br from-blue-500 to-violet-500" />
                  </span>
                </AssistantBubble>
              ) : null}
              {voiceError ? (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-100">
                  {voiceError}
                </p>
              ) : null}
              {voice.state === "requesting" ? (
                <p role="status" className="px-1 text-xs text-neutral-400">
                  Requesting microphone access...
                </p>
              ) : null}
              <div ref={threadEndRef} />
            </div>
          </div>

          <div className="border-t border-neutral-100 bg-white/80 p-3 backdrop-blur-sm">
            {voice.state !== "recording" && voice.state !== "reviewing" && !isFirstOpenEver && messages.length === 0 ? (
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={focusPasteText}
                  className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 transition-colors hover:bg-sky-100"
                >
                  📋 Paste Text
                </button>
                {SUGGESTION_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void sendMessage(prompt)}
                    className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : null}
            {voice.state === "recording" || voice.state === "reviewing" ? (
              <VoicePanel
                state={voice.state}
                liveText={voice.liveText}
                analyser={voice.analyser}
                onChangeText={voice.updateLiveText}
                onStop={voice.stop}
                onCancelRecording={voice.cancel}
                onDiscard={voice.discardReview}
                onConfirm={confirmVoiceMessage}
              />
            ) : (
              <form onSubmit={handleSubmit} className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage(inputValue);
                    }
                  }}
                  maxLength={ASSISTANT_MESSAGE_MAX_LENGTH}
                  rows={1}
                  placeholder="Type a request, or paste a transcript..."
                  disabled={isSending}
                  className="max-h-24 min-h-11 flex-1 resize-none rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm text-neutral-900 shadow-inner outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:shadow-none focus:ring-2 focus:ring-sky-500/30 disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => voice.start()}
                  disabled={isSending || voice.state === "requesting"}
                  aria-label="Start recording"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200 transition-all duration-150 hover:-translate-y-0.5 hover:bg-neutral-200 hover:text-neutral-700 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                >
                  <MicrophoneIcon className="h-4 w-4" />
                </button>
                <button
                  type="submit"
                  disabled={isSending || !inputValue.trim()}
                  aria-label="Send"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 text-white shadow-md shadow-violet-600/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-violet-600/35 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
                >
                  <SendIcon className="h-4 w-4" />
                </button>
              </form>
            )}
          </div>
        </div>
      ) : null}

      {/* The SAME six dialogs manual entry already uses — see this
          component's own header for why nothing here is a second
          write path. Each create dialog renders no visible trigger of
          its own here (renderTrigger={() => null} for all three);
          aiPrefill is the only thing that ever opens one from this
          component. CreateLeadDialog's own renderTrigger prop is what
          makes this possible for leads too — it used to hardcode a
          visible "New Lead" button with no way to suppress it, which is
          exactly what put that button on every page in the app once
          this launcher mounted it globally (fixed by giving
          CreateLeadDialog the same renderTrigger pattern
          AddTaskDialog/NewContactDialog already had). */}
      <CreateLeadDialog
        stages={stages}
        owners={teamDirectory}
        role={role}
        currentUserEmail={currentUserEmail}
        renderTrigger={() => null}
        aiPrefill={leadPrefill}
        onAiPrefillConsumed={() => setLeadPrefill(null)}
      />
      <AddTaskDialog
        assignableUsers={teamDirectory}
        currentUserCustomerUserId={currentUserCustomerUserId}
        renderTrigger={() => null}
        aiPrefill={taskPrefill}
        onAiPrefillConsumed={() => setTaskPrefill(null)}
      />
      <NewContactDialog
        assignableUsers={teamDirectory}
        currentUserCustomerUserId={currentUserCustomerUserId}
        renderTrigger={() => null}
        aiPrefill={contactPrefill}
        onAiPrefillConsumed={() => setContactPrefill(null)}
      />

      {editingLead ? (
        <EditLeadDialog
          lead={editingLead}
          stages={stages}
          owners={teamDirectory}
          role={role}
          currentUserEmail={currentUserEmail}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onClose={() => setEditingLead(null)}
        />
      ) : null}
      {editingTask ? (
        <EditTaskDialog
          task={editingTask.task}
          lockedLeadLabel={editingTask.lockedLeadLabel}
          assignableUsers={teamDirectory}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onClose={() => setEditingTask(null)}
        />
      ) : null}
      {editingContact ? (
        <EditContactDialog
          contact={editingContact.contact}
          lockedLeadLabel={editingContact.lockedLeadLabel}
          assignableUsers={teamDirectory}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onClose={() => setEditingContact(null)}
        />
      ) : null}
    </>
  );
}

/**
 * This product's own "P" mark — the identical asset the sidebar's own
 * logo badge uses (BRAND_MARK_SRC, from lib/brand.ts), reused here
 * instead of the generic circular-arrow glyph ChatBubbleIcon actually
 * draws (its name suggests a speech bubble; its real SVG path is a
 * loop, which read as a spinner/refresh icon rather than anything
 * assistant-related — see the launcher button, the header badge, and
 * every assistant message's own avatar, all of which used to render
 * it). A real, recognizable brand mark reads far more intentional in
 * all three places. The asset itself is opaque on a near-white
 * background (see BRAND_MARK_SRC's own doc comment), so every caller
 * wraps it in an explicit white/near-white surface first, matching the
 * sidebar's own established convention — never placed directly on a
 * colored background.
 */
function PipewayMark({ size }: { size: number }) {
  return (
    <Image
      src={BRAND_MARK_SRC}
      alt={BRAND_NAME}
      width={BRAND_MARK_WIDTH}
      height={BRAND_MARK_HEIGHT}
      className="h-full w-full rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

/** A small speaker glyph for the header's own mute/voice toggle — drawn
 *  locally (not added to the shared sidebar icon set) since this UI
 *  pass is scoped to the assistant panel alone. Matches that shared
 *  set's own stroke style (viewBox 0 0 24 24, 1.75 stroke, round caps)
 *  purely so it blends in next to CloseIcon/MicrophoneIcon here, not
 *  because it needs to be reused anywhere else. */
function SpeakerIcon({ muted, className }: { muted: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      {muted ? <path d="M16.5 8.5l5 7M21.5 8.5l-5 7" /> : <path d="M16 8.5a5 5 0 0 1 0 7M19 5.5a9 9 0 0 1 0 13" />}
    </svg>
  );
}

function AssistantBubble({ role, children }: { role: AssistantMessage["role"]; children: React.ReactNode }) {
  const isUser = role === "user";
  return (
    <div className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <span
        aria-hidden="true"
        className={`mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full shadow-sm ${
          isUser ? "bg-gradient-to-br from-neutral-500 to-neutral-700 text-white" : "bg-white p-1 ring-1 ring-neutral-200"
        }`}
      >
        {isUser ? <span className="text-[10px] font-bold">You</span> : <PipewayMark size={16} />}
      </span>
      <div
        className={`max-w-[80%] px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
          isUser
            ? "rounded-2xl rounded-br-md bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 text-white"
            : "rounded-2xl rounded-bl-md bg-white text-neutral-800 ring-1 ring-neutral-100"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The small copy/speak/regenerate/timestamp row beneath a plain-text
 * assistant reply — the greeting, a summary, a clarifying question, a
 * success confirmation. NEVER rendered for a user's own message, and
 * NEVER rendered anywhere near PendingActionCard (that card already has
 * its own real Confirm/Cancel/"Edit instead" buttons for a PENDING
 * decision; this row is for a FINISHED response, and the two are placed
 * side by side deliberately never overlapping — see this component's
 * own callers).
 *
 * `onRegenerate` is OPTIONAL, and its mere presence is what shows the
 * button at all — the caller decides per-message whether regenerating
 * makes sense (see DisplayMessage's own `regenerate` field and every
 * place that does or deliberately does NOT set it).
 */
function MessageActionRow({
  text,
  createdAt,
  nowMs,
  isSpeaking,
  onSpeak,
  onRegenerate,
}: {
  text: string;
  createdAt: number;
  nowMs: number;
  isSpeaking: boolean;
  onSpeak: () => void;
  onRegenerate?: () => void;
}) {
  const [justCopied, setJustCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1500);
    } catch {
      // Clipboard permission can be denied/unavailable — the only
      // consequence is that the "Copied!" confirmation never shows;
      // nothing else in this feature depends on the copy succeeding.
    }
  }

  return (
    <div className="flex items-center gap-3 pl-8 text-neutral-400">
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy message"
        title={justCopied ? "Copied!" : "Copy"}
        className="transition-colors hover:text-neutral-600"
      >
        {justCopied ? <CheckIcon className="h-3.5 w-3.5 text-emerald-500" /> : <CopyIcon className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={onSpeak}
        aria-label={isSpeaking ? "Stop speaking" : "Speak this message aloud"}
        title={isSpeaking ? "Stop" : "Speak"}
        className={`transition-colors hover:text-neutral-600 ${isSpeaking ? "text-violet-500" : ""}`}
      >
        <SpeakerIcon muted={false} className="h-3.5 w-3.5" />
      </button>
      {onRegenerate ? (
        <button
          type="button"
          onClick={onRegenerate}
          aria-label="Regenerate this response"
          title="Regenerate"
          className="transition-colors hover:text-neutral-600"
        >
          <RefreshIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <span className="text-[11px]">{formatRelativeTime(new Date(createdAt).toISOString(), nowMs)}</span>
    </div>
  );
}

/**
 * The inline confirmation card itself — replaces the old "open the real
 * dialog immediately" step for a create/edit turn (see actions.ts's own
 * AssistantTurnResult header). Every field is a labeled row, never a
 * run-on sentence; an EDIT field renders as a struck-through previous
 * value → its new one, a CREATE field just shows its value — matching
 * AssistantPendingActionField's own before/after contract exactly.
 *
 * `status` drives which footer renders: "pending" shows the three real
 * buttons (Confirm never fires from anything but this exact button's
 * own onClick — see AssistantPendingAction's own header for why a typed
 * "yes" can never reach this); "confirmed"/"cancelled" replace them with
 * a plain, non-interactive status line, so a resolved card sitting in
 * scrollback can never be clicked again.
 */
function PendingActionCard({
  pendingAction,
  status,
  busy,
  pending,
  onConfirm,
  onCancel,
  onEditInstead,
}: {
  pendingAction: AssistantPendingAction;
  status: PendingActionStatus;
  /** true while ANY card (not necessarily this one) is mid-submit —
   *  disables every card's buttons so two confirms can never race. */
  busy: boolean;
  /** true only while THIS card is the one mid-submit — swaps its own
   *  Confirm label to "Saving...". */
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onEditInstead: () => void;
}) {
  return (
    <div className="w-full max-w-[85%] overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-md shadow-neutral-200/60">
      <div className="flex items-center gap-2 bg-gradient-to-r from-sky-50 to-violet-50 px-3.5 py-2.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500 text-white">
          <CheckIcon className="h-3 w-3" />
        </span>
        <p className="text-sm font-semibold text-neutral-800">{pendingAction.title}</p>
      </div>

      <dl className="flex flex-col gap-1.5 px-3.5 pt-3">
        {pendingAction.fields.map((field) => (
          <div key={field.label} className="flex items-baseline justify-between gap-4 text-sm">
            <dt className="shrink-0 text-neutral-500">{field.label}</dt>
            <dd className="text-right font-medium text-neutral-800">
              {field.previousValue !== undefined ? (
                <>
                  <span className="font-normal text-neutral-400 line-through decoration-neutral-300">{field.previousValue}</span>
                  <span aria-hidden="true" className="mx-1.5 text-violet-400">
                    →
                  </span>
                  {field.value}
                </>
              ) : (
                field.value
              )}
            </dd>
          </div>
        ))}
      </dl>

      {status === "pending" ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-neutral-100 px-3.5 pt-3 pb-3.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-9 rounded-full border border-neutral-300 px-4 py-1.5 text-xs font-semibold text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onEditInstead}
            disabled={busy}
            className="min-h-9 rounded-full border border-sky-200 px-4 py-1.5 text-xs font-semibold text-sky-700 transition-colors hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Edit instead
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="min-h-9 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Saving..." : "Confirm"}
          </button>
        </div>
      ) : (
        <p
          className={`mt-3 border-t border-neutral-100 px-3.5 pt-3 pb-3.5 text-xs font-medium ${
            status === "confirmed" ? "text-emerald-600" : "text-neutral-400"
          }`}
        >
          {status === "confirmed" ? "✓ Saved" : "Cancelled — nothing was saved."}
        </p>
      )}
    </div>
  );
}

/** How many bars the live waveform renders — enough to read as a real
 *  waveform, not so many they look cramped inside the recording panel. */
const WAVEFORM_BAR_COUNT = 18;

/**
 * Human speech's energy sits in roughly the lower half of what this
 * AnalyserNode reports (voiced fundamentals and formants, well under
 * 4kHz) — sampling the FULL frequency range crowded all the visible
 * motion into the first few bars while the rest sat permanently flat.
 * Restricting to the fraction that actually moves for a voice, then
 * spreading THAT evenly across every bar, keeps the whole row alive
 * instead of lopsided.
 */
const USEFUL_BIN_FRACTION = 0.5;

/**
 * A live, audio-reactive bar visualizer for the recording panel below.
 * Each bar's height comes directly from the microphone's own frequency
 * data on every animation frame — silence keeps every bar near its
 * resting height, and louder speech visibly pushes bars higher, so it's
 * immediately obvious the mic is actually picking up sound (the problem
 * this whole feature exists to fix), not a decorative loop that plays
 * the same regardless of what's happening in the room. Bars grow from
 * their own center rather than their base, which reads as a calmer,
 * more even "level meter" than a jagged bottom-anchored skyline.
 *
 * Driven via refs, not React state: writing this many numbers into
 * component state on every animation frame would re-render this whole
 * tree 60 times a second for no reason a screen reader or the rest of
 * the chat panel needs to know about. `analyser` (a Web Audio
 * AnalyserNode) is the only thing that changes identity across a
 * render, so it's the only thing in this effect's dependency array.
 */
function VoiceWaveform({ analyser }: { analyser: AnalyserNode | null }) {
  const barRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const usableBins = Math.max(WAVEFORM_BAR_COUNT, Math.floor(data.length * USEFUL_BIN_FRACTION));
    const bucketSize = Math.max(1, Math.floor(usableBins / WAVEFORM_BAR_COUNT));
    let frameId: number;

    function tick() {
      analyser!.getByteFrequencyData(data);
      for (let i = 0; i < WAVEFORM_BAR_COUNT; i += 1) {
        let sum = 0;
        for (let j = 0; j < bucketSize; j += 1) {
          sum += data[i * bucketSize + j] ?? 0;
        }
        const level = sum / bucketSize / 255;
        // A mild gain: this narrower, voice-relevant band reads quieter
        // on average than the full spectrum's occasional loud outlier
        // bin did, so the same raw level needs a small boost to still
        // fill the bar the way it used to.
        const scale = Math.min(1, Math.max(0.22, level * 1.7));
        const bar = barRefs.current[i];
        if (bar) bar.style.transform = `scaleY(${scale})`;
      }
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [analyser]);

  return (
    <div className="flex h-12 items-center justify-center gap-1 rounded-xl bg-white/70 px-3" aria-hidden="true">
      {Array.from({ length: WAVEFORM_BAR_COUNT }).map((_, index) => (
        <div
          key={index}
          ref={(element) => {
            barRefs.current[index] = element;
          }}
          className="h-full w-1.5 origin-center rounded-full bg-gradient-to-b from-blue-500 to-violet-600 transition-transform duration-75 ease-out"
          style={{ transform: "scaleY(0.22)" }}
        />
      ))}
    </div>
  );
}

/**
 * Replaces the normal type/mic/send row while a voice message is being
 * recorded or reviewed — same rounded-container position, so nothing
 * jumps around when it appears or disappears.
 *
 * TWO SUB-VIEWS, matching VoiceRecorderState exactly:
 *   "recording" — the waveform above, live interim text below it
 *     (updating as the user is still speaking — never only once they
 *     stop), a small Cancel to abandon the recording outright, and
 *     Stop & review to move on.
 *   "reviewing" — the settled transcript in a real, editable textarea.
 *     NOTHING here has been sent yet: Discard throws it away, Send is
 *     the one and only action that hands it to the chat pipeline — see
 *     confirmVoiceMessage in the parent component.
 */
function VoicePanel({
  state,
  liveText,
  analyser,
  onChangeText,
  onStop,
  onCancelRecording,
  onDiscard,
  onConfirm,
}: {
  state: "recording" | "reviewing";
  liveText: string;
  analyser: AnalyserNode | null;
  onChangeText: (text: string) => void;
  onStop: () => void;
  onCancelRecording: () => void;
  onDiscard: () => void;
  onConfirm: () => void;
}) {
  if (state === "recording") {
    return (
      <div className="flex flex-col gap-2.5 rounded-2xl bg-red-50 p-3.5 shadow-sm ring-1 ring-red-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            <span role="status" className="text-xs font-semibold text-red-700">
              Listening...
            </span>
          </div>
          <button
            type="button"
            onClick={onCancelRecording}
            className="text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-600"
          >
            Cancel
          </button>
        </div>

        <VoiceWaveform analyser={analyser} />

        <p className="min-h-[1.25rem] text-sm text-neutral-700">
          {liveText || <span className="text-neutral-400">Say something...</span>}
        </p>

        <button
          type="button"
          onClick={onStop}
          className="self-end rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700"
        >
          Stop &amp; review
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl bg-sky-50 p-3.5 shadow-sm ring-1 ring-sky-100">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-sky-700">
        <CheckIcon className="h-3.5 w-3.5" />
        Review before sending — edit anything that was misheard.
      </p>
      <textarea
        value={liveText}
        onChange={(event) => onChangeText(event.target.value)}
        rows={2}
        autoFocus
        className="w-full resize-none rounded-xl border border-transparent bg-white px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDiscard}
          className="min-h-9 rounded-full border border-neutral-300 px-4 py-1.5 text-xs font-semibold text-neutral-600 transition-colors hover:bg-neutral-50"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!liveText.trim()}
          className="min-h-9 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
