import type { TeamDirectoryEntry } from "@/types/lead";

/**
 * One shared, deterministic source for "what do we call this owner in
 * the UI" — used everywhere an owner is listed (the List View's Owner
 * column, the Pipeline "All owners" filter, the Add/Edit Lead owner
 * picker, the Board View's owner avatar tooltip), so the disambiguation
 * rule below can never drift into a different implementation in one
 * place vs. another.
 *
 * Name is preferred; email is the fallback for a member with no name on
 * file yet (see this migration's own notes — right now that's the
 * common case, since inviting a teammate isn't wired up yet and only a
 * customer's own signup Primary Admin has a name set).
 */

type OwnerLike = Pick<TeamDirectoryEntry, "customer_user_id" | "email" | "name">;

/**
 * Maps customer_user_id -> the label to display. When two or more
 * owners share the exact same name (case/whitespace-insensitive), each
 * colliding entry's label grows a "(email)" suffix so they're
 * distinguishable — a uniquely-named owner, or one falling back to
 * email already (which is inherently unique — one auth user per
 * email), never gets that suffix.
 */
export function getOwnerDisplayLabels(owners: OwnerLike[]): Map<string, string> {
  const baseLabelByOwnerId = new Map<string, string>();
  const countByNormalizedName = new Map<string, number>();

  for (const owner of owners) {
    const trimmedName = owner.name?.trim();
    baseLabelByOwnerId.set(owner.customer_user_id, trimmedName || owner.email);

    if (trimmedName) {
      const normalized = trimmedName.toLowerCase();
      countByNormalizedName.set(normalized, (countByNormalizedName.get(normalized) ?? 0) + 1);
    }
  }

  const displayLabelByOwnerId = new Map<string, string>();
  for (const owner of owners) {
    const baseLabel = baseLabelByOwnerId.get(owner.customer_user_id) ?? owner.email;
    const trimmedName = owner.name?.trim();
    const isCollidingName = Boolean(trimmedName) && (countByNormalizedName.get(trimmedName!.toLowerCase()) ?? 0) > 1;

    displayLabelByOwnerId.set(owner.customer_user_id, isCollidingName ? `${baseLabel} (${owner.email})` : baseLabel);
  }

  return displayLabelByOwnerId;
}

/**
 * Initials for the colored avatar circle — always derived from the
 * name when one exists (never from the disambiguated label, which may
 * carry a "(email)" suffix that would otherwise pollute this), falling
 * back to the email's first character, matching this app's existing
 * email-only initial behavior for a member with no name on file.
 */
export function getOwnerInitials(owner: OwnerLike): string {
  const trimmedName = owner.name?.trim();
  if (!trimmedName) {
    return owner.email.charAt(0).toUpperCase();
  }

  const parts = trimmedName.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
  return (parts[0]?.charAt(0) ?? owner.email.charAt(0)).toUpperCase();
}

/**
 * Hover-tooltip text — always pairs name with email when a name exists
 * (regardless of whether that name happens to collide with anyone
 * else's), so the email stays reachable for reference without being
 * the primary on-screen label. Reduces to just the email when there's
 * no name, matching what's already visible in that case.
 */
export function getOwnerTooltip(owner: OwnerLike): string {
  const trimmedName = owner.name?.trim();
  return trimmedName ? `${trimmedName} (${owner.email})` : owner.email;
}

// Consistent per-owner avatar color — keyed off owner/assignee id (a
// stable uuid) rather than the display text, so the same person always
// gets the same color regardless of what's shown next to it. Originally
// local to PipelineView; moved here once the Tasks module needed the
// exact same avatar coloring for the same people (see CLAUDE.md Section
// M — promote once a real second consumer exists, not speculatively).
const OWNER_AVATAR_PALETTE = [
  "bg-blue-600",
  "bg-violet-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-sky-600",
  "bg-teal-600",
  "bg-indigo-600",
];

export function getOwnerAvatarColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % OWNER_AVATAR_PALETTE.length;
  }
  return OWNER_AVATAR_PALETTE[Math.abs(hash) % OWNER_AVATAR_PALETTE.length];
}
