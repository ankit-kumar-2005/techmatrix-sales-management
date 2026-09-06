"use client";

import { useEffect } from "react";
import { CloseIcon } from "@/features/sales-management/components/icons";

type ModalProps = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * Generic centered modal — dark overlay, Escape-to-close, click-outside-
 * to-close. No dialog/modal library existed in this project yet, so this
 * is the one reusable primitive for that instead of a one-off per
 * feature. Mounted only while open by the caller (not always-mounted
 * like the off-canvas nav drawers), which is enough here since opening
 * it is a deliberate click, not something that needs to feel instant.
 */
export function Modal({ title, onClose, children }: ModalProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl ring-1 ring-black/5"
      >
        <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
