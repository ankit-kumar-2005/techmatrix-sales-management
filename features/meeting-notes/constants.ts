/**
 * Values shared by the server extraction module, the Zod input schemas,
 * and the client form — deliberately in a module of their own.
 *
 * WHY NOT JUST EXPORT THESE FROM lib/openrouter.ts: the client form
 * needs them (textarea maxLength, the file input's accept list, the
 * size hint), and importing from the OpenRouter module would put an
 * import edge from a "use client" component into the one module that
 * reads process.env.OPENROUTER_API_KEY. It happens to bundle safely
 * today — the built client chunks contain neither the key nor the
 * endpoint — but only by the bundler's grace. Add one side-effecting
 * line or one more shared export to that module and the edge starts
 * pulling server code toward the browser.
 *
 * A plain constants module has no such edge to begin with: the
 * difference between "verified safe in this build" and "cannot happen".
 */

/** A meeting note is a page of text, not a document. Caps the request
 *  before it is sent: the models in the chain carry 262,144-token
 *  contexts, so this is not a model limit but a cost-and-abuse limit on
 *  a feature any signed-in member can invoke. */
export const MEETING_NOTES_MAX_LENGTH = 8000;

/**
 * Image upload limits, enforced BEFORE anything reaches OpenRouter.
 *
 * 4 MB because base64 inflates the payload by roughly a third, so this
 * is already ~5.3 MB on the wire to a free-tier endpoint. A phone photo
 * of a whiteboard lands comfortably under it; a 12 MP raw screenshot
 * does not, and should be told so instantly rather than after a 45-second
 * upload that the provider then rejects.
 */
export const MEETING_NOTES_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Matches the avatar upload's own accept list — the only existing
 *  image-upload precedent in this project — plus HEIC, which is what an
 *  iPhone photo of a whiteboard actually is by default. Checked
 *  server-side too: an accept attribute is a file-picker filter, not a
 *  validation. */
export const MEETING_NOTES_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
] as const;

export const MEETING_NOTES_IMAGE_ACCEPT = MEETING_NOTES_IMAGE_MIME_TYPES.join(",");

/** Which input the user submitted. Mirrors meeting_notes.source_kind's
 *  own CHECK vocabulary ('Text' | 'Image'). */
export const MEETING_NOTES_SOURCE_KINDS = ["Text", "Image"] as const;
export type MeetingNotesSourceKind = (typeof MEETING_NOTES_SOURCE_KINDS)[number];

/**
 * "Rows Per Page" options, matching Contacts, Tasks, Invitations and the
 * Pipeline List View exactly.
 *
 * There is no shared pagination component in this codebase — the pattern
 * is copy-implemented in five features — so "reuse the convention" here
 * means reusing these numbers, the control's label and its placement,
 * not importing a component that does not exist. Promoting one is a
 * worthwhile refactor but it would touch five working features, which is
 * not this pass.
 *
 * 10/15/20 rather than the suggested 5/10/20 for that consistency: a
 * user who has learned the control on Contacts should not find different
 * numbers here. Collapsed rows are short, so 10 is comfortable.
 */
export const MEETING_NOTES_PAGE_SIZE_OPTIONS = [10, 15, 20] as const;
export const MEETING_NOTES_DEFAULT_PAGE_SIZE = 10;
