"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "@/features/sales-management/components/icons";

type ModalProps = {
  title: string;
  /** Short helper line under the title — omitted entirely when absent,
   *  not reserved as empty space. */
  subtitle?: string;
  /** A fully pre-styled element (e.g. an icon inside its own colored
   *  chip `<span>`), rendered as-is next to the title — the same
   *  "pass a pre-rendered element, not a bare icon" convention
   *  KpiCards already uses, so each caller keeps control of its own
   *  accent color (teal for Catalog, sky for Tasks, ...) rather than
   *  Modal imposing one fixed color on everyone. */
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * Generic centered modal — soft dark backdrop, Escape-to-close, click-
 * outside-to-close, a focus trap while open, and focus returned to
 * whatever triggered it on close. No dialog/modal library existed in
 * this project yet, so this is the one reusable primitive for that
 * instead of a one-off per feature. Mounted only while open by the
 * caller (not always-mounted like the off-canvas nav drawers), which is
 * enough here since opening it is a deliberate click, not something
 * that needs to feel instant.
 *
 * `subtitle`/`icon` are optional and additive — every existing caller
 * that only passes `title` renders exactly as before, just with the
 * refreshed backdrop/shadow/entrance-animation/focus-handling that now
 * applies to all of them equally (a shared-component upgrade, not a
 * one-off skin on top of it), matching the app's own established
 * "promote once genuinely shared" convention.
 *
 * PORTALED to document.body — not rendered in place. `position: fixed`
 * only escapes normal layout; it does NOT escape an ancestor's CSS
 * containing block, and any ancestor with `transform` (e.g. the Catalog
 * card's `hover:-translate-y-0.5` hover-lift) becomes exactly that
 * containing block while active, trapping a same-place `fixed` Modal
 * inside that ancestor's box instead of the viewport — which is what
 * made EditCatalogItemDialog's Modal render clipped "inside the card"
 * when opened while the card was hovered. A portal sidesteps this
 * entirely: the Modal's DOM node lives directly under <body>,
 * completely independent of wherever it's invoked from in the React
 * tree, so no ancestor anywhere can ever re-trap it this way again.
 */
export function Modal({ title, subtitle, icon, onClose, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Runs once per mount/unmount (not per onClose identity change) —
  // onCloseRef above is what keeps the Escape handler always calling the
  // latest onClose without needing this effect itself to re-run and
  // re-trigger the focus-save/focus-move logic on every parent re-render.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialogNode = dialogRef.current;

    const focusableSelector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const firstFocusable = dialogNode?.querySelector<HTMLElement>(focusableSelector);
    firstFocusable?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogNode) return;

      const focusable = Array.from(dialogNode.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="modal-overlay-animate absolute inset-0 bg-neutral-950/50 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal-panel-animate relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl ring-1 ring-black/5"
      >
        <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-6 py-5">
          <div className="flex items-start gap-3">
            {icon}
            <div>
              <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
              {subtitle ? <p className="mt-0.5 text-xs text-neutral-500">{subtitle}</p> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
