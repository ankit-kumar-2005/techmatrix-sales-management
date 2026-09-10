"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_DURATION_MS = 700;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Returns `targetValue`, but animates smoothly toward it (via
 * requestAnimationFrame, eased) whenever it changes after the first
 * render — the first render always shows the real value immediately,
 * never counting up from 0.
 *
 * `null` (this project's "no data yet" state, e.g. Win Rate before any
 * lead has closed) is never animated into or out of — a transition
 * needs two real numbers to interpolate between, so a null on either
 * side of a change is applied immediately. The caller owns turning
 * `null` into a dash and a real number into its formatted string; this
 * hook only ever deals in raw numbers.
 *
 * currentValueRef (not just the previous *committed* value) is what
 * makes rapid consecutive changes clean rather than glitchy: if a new
 * target arrives mid-animation, the next animation starts from wherever
 * the number currently visually is, not from the start of the
 * interrupted one — no snap-back, no jump.
 *
 * Respects prefers-reduced-motion — skips straight to the new value.
 */
export function useCountUpTransition(
  targetValue: number | null,
  durationMs: number = DEFAULT_DURATION_MS,
): number | null {
  const [displayValue, setDisplayValue] = useState<number | null>(targetValue);
  const currentValueRef = useRef<number | null>(targetValue);
  const rafRef = useRef<number | null>(null);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    // First render for this hook instance: show the real value
    // immediately, no count-up from a placeholder.
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      currentValueRef.current = targetValue;
      setDisplayValue(targetValue);
      return;
    }

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const startValue = currentValueRef.current;

    // Nothing to interpolate: unchanged, or either side is the "no
    // data" state, or the user asked for no motion.
    if (targetValue === startValue || targetValue === null || startValue === null || prefersReducedMotion()) {
      currentValueRef.current = targetValue;
      setDisplayValue(targetValue);
      return;
    }

    // Rebind as explicitly-typed `number` consts here, where TypeScript
    // has already narrowed both away from `| null` (via the guard
    // above) — the nested tick() closure below then captures these
    // already-narrowed bindings directly, rather than needing `!`
    // non-null assertions inside the animation math itself.
    const numericStart: number = startValue;
    const numericTarget: number = targetValue;
    const startTime = performance.now();

    function tick(now: number) {
      const progress = Math.min((now - startTime) / durationMs, 1);
      const eased = easeOutCubic(progress);
      const next = numericStart + (numericTarget - numericStart) * eased;
      currentValueRef.current = next;
      setDisplayValue(next);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // Only targetValue/durationMs participate in "did this actually
    // change" — an unrelated parent re-render passing the same
    // targetValue does not re-run this effect at all (React's own
    // dependency-array equality check on these primitives already
    // guards that; no extra bookkeeping needed here).
  }, [targetValue, durationMs]);

  return displayValue;
}
