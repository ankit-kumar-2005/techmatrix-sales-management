/**
 * A neutral placeholder block for route-level loading fallbacks. No
 * animation of its own — the pulse (and its motion-reduce opt-out) is
 * applied once per skeleton screen on a wrapping element, so a single
 * loading.tsx animates as one surface rather than dozens of blocks
 * pulsing independently and slightly out of phase.
 *
 * Shared by the four app/(app)/*&#47;loading.tsx files (four real consumers,
 * so this belongs in components/shared/ per CLAUDE.md Section M rather
 * than being redefined per route).
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded bg-neutral-200/80 ${className}`} />;
}
