"use client";

import { useActionState, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useFormStatus } from "react-dom";
import { MessageBanner } from "@/components/shared/message-banner";
import {
  AutomationsIcon,
  CameraIcon,
  MeetingNotesIcon,
} from "@/features/sales-management/components/icons";
import { extractMeetingNotesAction } from "../actions";
import { initialMeetingNotesFormState } from "../form-state";
import {
  MEETING_NOTES_IMAGE_ACCEPT,
  MEETING_NOTES_IMAGE_MAX_BYTES,
  MEETING_NOTES_IMAGE_MIME_TYPES,
  MEETING_NOTES_MAX_LENGTH,
} from "../constants";

/**
 * The sample the "Try an example" link drops into the textarea.
 *
 * Chosen to actually exercise the extraction rather than just fill the
 * box: it states its own meeting date (so "by Friday" can be resolved
 * to a real ISO date, which the prompt only permits when the meeting
 * date is known), names two attendees, and contains two clearly
 * different action items — one with an anchored deadline and one
 * without. A first-time user clicking this sees the feature's actual
 * behaviour, including a null due date, not a toy result.
 */
const EXAMPLE_TRANSCRIPT = `Discovery call with Northwind Interiors, 12 Sep 2026.
Present: Ankit Singh (us), Kiran Pande (Northwind).
Kiran's team of 18 is tracking projects in spreadsheets and losing handoffs between design and site teams. Budget is signed off for this quarter. The open question is whether we can import their existing project history.
Ankit to send the pricing breakdown by Friday.
Ankit will check with the solutions team whether the spreadsheet import is feasible.`;

/** Percentage of the cap at which the character counter starts being
 *  emphasised. Unchanged from the earlier decision — only the counter's
 *  POSITION and visibility changed in this pass, not this threshold. */
const COUNTER_EMPHASIS_RATIO = 0.8;

function AnalyzeButton({ mode }: { mode: "Text" | "Image" }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center gap-2 self-start rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-sm"
    >
      <AutomationsIcon className="h-4 w-4" />
      {pending ? (mode === "Image" ? "Reading your image..." : "Analyzing...") : "Analyze Meeting Notes"}
    </button>
  );
}

/** Free-tier models are slow (10s+ measured, 45s worst case). Without
 *  this the only signal is a disabled button, which reads as a frozen
 *  page. */
function PendingHint({ mode }: { mode: "Text" | "Image" }) {
  const { pending } = useFormStatus();
  if (!pending) return null;

  return (
    <p role="status" className="text-xs leading-relaxed text-neutral-500">
      {mode === "Image" ? "Reading the image and extracting" : "Extracting"} a summary and action items. This
      runs on a free AI model and can take up to a minute. If the first model is busy it falls back to another
      automatically.
    </p>
  );
}

/**
 * The TEXTAREA IS NOW CONTROLLED, where it used to be uncontrolled.
 *
 * Both of this pass's additions need its current value: "Try an example"
 * has to write into it, and the live counter has to read it. Holding the
 * value in state gives both for free, and it also removes a workaround —
 * the previous version forced a remount via `key` to clear the box after
 * a successful save, which is now just an assignment.
 *
 * The FILE INPUT still uses that `key` trick, and has to: React cannot
 * control a file input's value, so remounting is the only clean way to
 * empty it. Both clear on success and both survive a failed submit.
 */
export function MeetingNotesForm() {
  const [state, formAction] = useActionState(extractMeetingNotesAction, initialMeetingNotesFormState);
  const [mode, setMode] = useState<"Text" | "Image">("Text");
  const fieldErrors = state.fieldErrors ?? {};
  const imageLimitMb = Math.round(MEETING_NOTES_IMAGE_MAX_BYTES / (1024 * 1024));

  const [notes, setNotes] = useState("");
  const [clientImageError, setClientImageError] = useState<string | null>(null);
  /** The chosen file's name and size, purely for feedback. The custom
   *  dropzone replaced the native input's own "No file chosen" text, so
   *  without this there would be NO confirmation that a file attached —
   *  a regression, not a nice-to-have. */
  const [selectedFile, setSelectedFile] = useState<{ name: string; sizeMb: string } | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  /** The real <input type="file">. Kept in the DOM and inside the form
   *  (visually hidden, NOT `hidden`, so it stays keyboard-focusable) so
   *  FormData still picks up `image` exactly as before — the dropzone is
   *  a skin over the native control, not a replacement for it. */
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Clear the inputs only after a SUCCESSFUL save. A failed submit
   * deliberately keeps what the user typed — that is the case where
   * losing it would cost real work.
   *
   * WRITTEN AS A RENDER-TIME STATE ADJUSTMENT, not an effect. React's
   * documented "adjusting state when a prop changes" pattern, and the
   * one AddTaskDialog / NewContactDialog / AddUserDialog already use for
   * exactly this (closing on success). It is also what this project's
   * React Compiler lint rule requires: setState inside an effect is a
   * hard error here, because it triggers a second render pass the
   * compiler cannot reason about.
   *
   * Comparing the state OBJECT by identity is what makes this fire once
   * per action response rather than on every render.
   */
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success) {
      setNotes("");
      setSelectedFile(null);
    }
  }

  /** One validator for both entry points — click-to-browse and drop —
   *  so a dragged file cannot bypass the checks a browsed one gets.
   *  Returns whether the file was accepted. The server re-validates
   *  regardless and remains the authority; this is about not making
   *  someone upload 12 MB to be told no. */
  function acceptFile(file: File | undefined): boolean {
    if (!file) {
      setClientImageError(null);
      setSelectedFile(null);
      return false;
    }
    if (!(MEETING_NOTES_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setClientImageError("That file type isn't supported. Upload a PNG, JPEG, WebP or HEIC image.");
      setSelectedFile(null);
      return false;
    }
    if (file.size > MEETING_NOTES_IMAGE_MAX_BYTES) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      setClientImageError(`That image is ${sizeMb} MB — the limit is ${imageLimitMb} MB. Try a smaller photo.`);
      setSelectedFile(null);
      return false;
    }
    setClientImageError(null);
    setSelectedFile({ name: file.name, sizeMb: (file.size / (1024 * 1024)).toFixed(1) });
    return true;
  }

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    acceptFile(event.target.files?.[0]);
  }

  /**
   * Drag-and-drop has to put the file on the real input, not just in
   * React state: the form submits via FormData read from the DOM, so a
   * file held only in state would never reach the Server Action.
   * Assigning the drop's own FileList to input.files is what actually
   * attaches it.
   *
   * A rejected file is NOT attached — the input is left untouched and
   * the error stands, so there is no way to drop an oversized image and
   * still have it submitted.
   */
  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingOver(false);

    const dropped = event.dataTransfer.files;
    if (!dropped || dropped.length === 0) return;

    if (acceptFile(dropped[0]) && fileInputRef.current) {
      fileInputRef.current.files = dropped;
    }
  }

  /** preventDefault on dragover is required — without it the browser
   *  navigates to the dropped file instead of firing onDrop. */
  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingOver(true);
  }

  /** Switching mode clears a stale file complaint and a stale filename:
   *  both refer to input that is no longer being submitted. */
  function handleModeChange(next: "Text" | "Image") {
    setMode(next);
    setClientImageError(null);
  }

  const imageError = clientImageError ?? fieldErrors.image;
  const isNearCap = notes.length >= MEETING_NOTES_MAX_LENGTH * COUNTER_EMPHASIS_RATIO;

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
      <div className="mb-5 inline-flex rounded-full bg-neutral-100 p-1">
        {(["Text", "Image"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => handleModeChange(option)}
            aria-pressed={mode === option}
            className={`min-h-9 rounded-full px-4 text-sm font-semibold transition-colors ${
              mode === option ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700"
            }`}
          >
            {option === "Text" ? "Paste notes" : "Upload image"}
          </button>
        ))}
      </div>

      {/* gap-3, down from gap-4: the input and the Analyze button read
          as one connected unit rather than two stacked blocks. */}
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="mode" value={mode} />

        {mode === "Text" ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="meeting-notes" className="flex items-center gap-1.5 text-sm font-medium text-neutral-700">
                {/* The sidebar's own Meeting Notes glyph, tying the form
                    back to where the user navigated from. */}
                <MeetingNotesIcon className="h-4 w-4 text-neutral-400" />
                Meeting notes
              </label>

              {/* A ghost link, not a primary button: an escape hatch for
                  someone with nothing to paste, not the main action.
                  Hidden once there is text, so it can never silently
                  overwrite real work with the sample. */}
              {notes.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setNotes(EXAMPLE_TRANSCRIPT)}
                  className="rounded text-xs font-semibold text-blue-600 underline-offset-2 transition-colors hover:text-violet-600 hover:underline focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
                >
                  Try an example
                </button>
              ) : null}
            </div>

            {/* relative, so the counter sits inside the box's
                bottom-right corner. pb-8 keeps typed text from running
                underneath it. */}
            <div className="relative">
              <textarea
                id="meeting-notes"
                name="notes"
                rows={8}
                maxLength={MEETING_NOTES_MAX_LENGTH}
                placeholder="Paste or type your notes. For example: Customer wants a product demo next week. Rahul will send the proposal by Friday."
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                aria-invalid={Boolean(fieldErrors.notes)}
                aria-describedby={fieldErrors.notes ? "meeting-notes-error" : "meeting-notes-counter"}
                className={`w-full resize-y rounded-lg border bg-neutral-100 px-3.5 pt-2.5 pb-8 text-sm leading-relaxed text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 ${
                  fieldErrors.notes ? "border-red-400" : "border-transparent hover:border-neutral-300"
                }`}
              />

              <span
                id="meeting-notes-counter"
                className={`pointer-events-none absolute right-3 bottom-2.5 text-[11px] tabular-nums transition-colors ${
                  isNearCap ? "font-semibold text-amber-600" : "text-neutral-400"
                }`}
              >
                {notes.length.toLocaleString("en-IN")} / {MEETING_NOTES_MAX_LENGTH.toLocaleString("en-IN")}
              </span>
            </div>

            {fieldErrors.notes ? (
              <p id="meeting-notes-error" role="alert" className="text-xs text-red-600">
                {fieldErrors.notes}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-sm font-medium text-neutral-700">
              <MeetingNotesIcon className="h-4 w-4 text-neutral-400" />
              Image of your notes
            </label>

            {/* A <label> wrapping the dropzone, with the real input
                visually hidden inside it. That is what makes this
                accessible for free: clicking anywhere on the zone
                activates the input, Tab reaches the input itself (it is
                sr-only, not hidden, so it stays focusable), and
                Space/Enter opens the picker. focus-within mirrors that
                focus onto the zone so keyboard users can see where they
                are. */}
            <label
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={() => setIsDraggingOver(false)}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-500/30 ${
                imageError
                  ? "border-red-400 bg-red-50/40"
                  : isDraggingOver
                    ? "border-sky-500 bg-sky-50"
                    : "border-neutral-300 bg-neutral-100 hover:border-neutral-400 hover:bg-neutral-50"
              }`}
            >
              <input
                /* Remounted after a successful save, which is what
                   actually empties a file input — React cannot control
                   its value, and writing to the ref during render would
                   be a side effect in the render path. A FAILED submit
                   keeps the same key, so a rejected upload keeps the
                   file attached and is retryable without re-picking. */
                key={state.meetingNoteId ?? "picker"}
                ref={fileInputRef}
                id="meeting-notes-image"
                name="image"
                type="file"
                accept={MEETING_NOTES_IMAGE_ACCEPT}
                onChange={handleImageChange}
                aria-invalid={Boolean(imageError)}
                aria-describedby={imageError ? "meeting-notes-image-error" : "meeting-notes-image-hint"}
                className="sr-only"
              />

              {/* CameraIcon rather than a new upload glyph: it is this
                  app's existing image-picking icon (the avatar upload
                  uses it) and "a photo of your notes" is exactly what
                  this accepts. */}
              <CameraIcon className={`h-6 w-6 ${isDraggingOver ? "text-sky-500" : "text-neutral-400"}`} />

              {selectedFile ? (
                <>
                  <p className="text-sm font-medium text-neutral-700">
                    {selectedFile.name}
                    <span className="ml-1.5 font-normal text-neutral-400">{selectedFile.sizeMb} MB</span>
                  </p>
                  <p className="text-xs text-neutral-400">Drop another image or click to replace it.</p>
                </>
              ) : (
                <p className="text-sm text-neutral-600">
                  <span className="font-semibold text-blue-600">Drag and drop an image</span>, or click to browse
                </p>
              )}
            </label>

            {imageError ? (
              <p id="meeting-notes-image-error" role="alert" className="text-xs text-red-600">
                {imageError}
              </p>
            ) : (
              <p id="meeting-notes-image-hint" className="text-xs text-neutral-400">
                Handwritten, whiteboard or a screenshot. PNG, JPEG, WebP or HEIC, under {imageLimitMb} MB. The
                image itself isn&rsquo;t stored — only the text read from it.
              </p>
            )}
          </div>
        )}

        {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

        {state.success ? (
          <MessageBanner tone="success">
            <p className="font-semibold">
              {state.actionItemCount === 0
                ? "Notes saved — no action items found"
                : `Notes saved with ${state.actionItemCount} action item${state.actionItemCount === 1 ? "" : "s"}`}
            </p>
            <p className="mt-0.5">
              {state.actionItemCount === 0
                ? "The AI didn't find anything actionable in this source, which is a valid result — the summary is still saved."
                : "The extracted summary and checklist are saved."}
              {state.tier && state.tier > 1
                ? ` The primary AI model was busy, so fallback model ${state.tier} handled this.`
                : ""}
            </p>
          </MessageBanner>
        ) : null}

        <AnalyzeButton mode={mode} />
        <PendingHint mode={mode} />
      </form>
    </div>
  );
}
