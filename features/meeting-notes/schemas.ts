import { z } from "zod";
import {
  MEETING_NOTES_IMAGE_MAX_BYTES,
  MEETING_NOTES_IMAGE_MIME_TYPES,
  MEETING_NOTES_MAX_LENGTH,
} from "./constants";

/**
 * INPUT validation — what the user submitted, before anything is sent
 * anywhere. Distinct from lib/extraction-schema.ts, which validates what
 * the MODEL sent back; the two are different trust boundaries and
 * deliberately different files.
 */

/** Field name matches the textarea's own `name` so FormData maps
 *  straight through with no translation layer in the action — the same
 *  convention createInvitationSchema and createLeadSchema follow.
 *
 *  The length ceiling is imported rather than restated, so the number
 *  the user is validated against and the number the request is capped at
 *  cannot drift. */
export const analyzeTextSchema = z.object({
  notes: z
    .string()
    .trim()
    .min(1, "Enter some meeting notes to analyze.")
    .max(
      MEETING_NOTES_MAX_LENGTH,
      `Meeting notes must be ${MEETING_NOTES_MAX_LENGTH.toLocaleString("en-IN")} characters or fewer.`,
    ),
});

/**
 * Image validation is DELIBERATELY NOT a Zod schema.
 *
 * A File coming out of FormData is a runtime object, not a plain value:
 * Zod's own file support would mean either z.instanceof(File) (which
 * behaves differently across the Node/edge/browser File implementations
 * this could run under) or z.custom with the same checks written inside
 * it. Neither buys anything over three explicit conditions, and both
 * make the failure messages harder to keep specific.
 *
 * WHAT MATTERS is that all three checks run BEFORE any network call, so
 * a 20 MB PDF is rejected instantly rather than after being base64'd and
 * shipped to a free-tier endpoint that will refuse it 40 seconds later.
 *
 * The MIME type is taken from the File, which comes from the browser and
 * is therefore a claim, not a fact — a renamed .exe can present as
 * image/png. That is accepted here: the "file" is never executed, never
 * written to disk, and never stored. It is base64'd into one request
 * body and discarded, so a mislabelled file's worst outcome is the model
 * failing to read it. Sniffing magic bytes would be the right move the
 * moment v1's text-only decision is revisited and binaries start being
 * persisted (see the migration's fast-follow note).
 */
export type ImageValidationResult =
  | { ok: true; file: File }
  | { ok: false; message: string };

export function validateImageUpload(value: unknown): ImageValidationResult {
  // Not `instanceof File`: an empty file input still submits an entry,
  // and duck-typing the three properties actually used keeps this
  // working across runtimes without a platform-specific check.
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as File).size !== "number" ||
    typeof (value as File).type !== "string" ||
    typeof (value as File).arrayBuffer !== "function"
  ) {
    return { ok: false, message: "Choose an image of your notes to analyze." };
  }

  const file = value as File;

  // An empty file input submits a zero-byte entry named "" — that is
  // "nothing was chosen", not "a corrupt file".
  if (file.size === 0) {
    return { ok: false, message: "Choose an image of your notes to analyze." };
  }

  if (!(MEETING_NOTES_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return {
      ok: false,
      message: "That file type isn't supported. Upload a PNG, JPEG, WebP or HEIC image.",
    };
  }

  if (file.size > MEETING_NOTES_IMAGE_MAX_BYTES) {
    const limitMb = Math.round(MEETING_NOTES_IMAGE_MAX_BYTES / (1024 * 1024));
    return {
      ok: false,
      message: `That image is too large. Upload one under ${limitMb} MB.`,
    };
  }

  return { ok: true, file };
}

/** Which input the form submitted. A hidden field rather than inferred
 *  from which value is present, so an empty textarea in image mode
 *  produces "choose an image" rather than "enter some notes". */
export const analyzeModeSchema = z.enum(["Text", "Image"]);
