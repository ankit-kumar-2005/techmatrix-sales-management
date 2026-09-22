"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SUBJECT_TOKENS } from "../registry/definitions";

type FieldReferencePickerProps = {
  /** Where to insert the picked token — the field's own current value
   *  and its onChange, so this component never has to know which kind
   *  of input (a plain `<input>` or a `<textarea>`) it is decorating. */
  value: string;
  onInsert: (nextValue: string) => void;
  disabled?: boolean;
};

/**
 * THE TWO-STEP FIELD REFERENCE PICKER.
 *
 * Lets an admin insert a `{{lead.*}}` token without typing its exact
 * syntax by hand. Two steps, not one flat list, and deliberately
 * structured as a list of SOURCES (step 1) each expanding to a list of
 * FIELDS (step 2) even though exactly one source — the lead that
 * triggered this automation — exists today: a value from an earlier
 * "Set a variable" step is the obvious next source, and this shape
 * costs nothing extra to support that later versus a single flat field
 * list that would need redesigning to add one.
 *
 * The field list is SUBJECT_TOKENS — itself derived from
 * LEAD_FIELD_REGISTRY (see definitions.ts) — so this picker can never
 * offer a field the registry does not also grant to a condition, and a
 * new registry field becomes pickable here with no change to this file.
 *
 * Only ever attached to a field the registry has marked
 * `templated: true` (see FieldDescriptor's own note) — the one thing
 * that keeps this from ever inserting a token into a field that would
 * just display it back literally, unresolved.
 */
export function FieldReferencePicker({ value, onInsert, disabled }: FieldReferencePickerProps) {
  const [step, setStep] = useState<"source" | "lead-fields" | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  const open = step !== null;

  function openPicker() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ left: rect.left, top: rect.bottom + 6 });
    setStep("source");
  }

  function close() {
    setStep(null);
    setAnchor(null);
  }

  function pick(token: string) {
    onInsert(`${value}${token}`);
    close();
  }

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        close();
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={openPicker}
        title="Insert a field from the lead that started this automation"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-sky-600 hover:bg-sky-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
      >
        <BracketsIcon />
        Insert field
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="Insert a field"
              style={{ position: "fixed", left: Math.max(8, anchor.left), top: anchor.top }}
              className="z-[999] flex max-h-80 w-64 flex-col overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-black/10"
            >
              {step === "source" ? (
                <div className="flex flex-col p-1.5">
                  <p className="px-2 py-1 text-[10px] font-bold tracking-wide text-neutral-400 uppercase">
                    Pick a source
                  </p>
                  <button
                    type="button"
                    onClick={() => setStep("lead-fields")}
                    className="flex flex-col items-start rounded-lg px-2.5 py-2 text-left hover:bg-sky-50 focus-visible:bg-sky-50 focus-visible:outline-none"
                  >
                    <span className="text-xs font-semibold text-neutral-800">Lead</span>
                    <span className="text-[11px] text-neutral-500">The record that started this automation</span>
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1 border-b border-neutral-100 p-2">
                    <button
                      type="button"
                      onClick={() => setStep("source")}
                      aria-label="Back to sources"
                      className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
                    >
                      <BackIcon />
                    </button>
                    <p className="text-[11px] font-semibold text-neutral-600">Lead fields</p>
                  </div>
                  <ul className="flex-1 overflow-y-auto p-1.5">
                    {SUBJECT_TOKENS.map((field) => (
                      <li key={field.token}>
                        <button
                          type="button"
                          onClick={() => pick(field.token)}
                          className="w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-sky-50 focus-visible:bg-sky-50 focus-visible:outline-none"
                        >
                          <span className="block text-xs font-semibold text-neutral-800">{field.description}</span>
                          <span className="block font-mono text-[10px] text-neutral-400">{field.token}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function BracketsIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth={2}>
      <path d="M7 4H5v12h2M13 4h2v12h-2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth={2}>
      <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
