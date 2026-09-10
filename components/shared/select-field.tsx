import type { ReactNode, SelectHTMLAttributes } from "react";
import { ChevronDownIcon } from "@/features/sales-management/components/icons";

type SelectFieldProps = {
  label: string;
  id: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
  /** Short hint below the select — only rendered when there's no active
   *  error, matching FormField's identical helperText behavior. */
  helperText?: string;
} & SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Matches FormField's "filled" variant so every control in a form reads
 * as one set. Promoted here from features/leads/components/
 * lead-form-fields.tsx (its original, still-local definition) once a
 * second real consumer (Catalog's item form) needed the identical
 * pattern — see CLAUDE.md Section M: start local, promote once actually
 * reused, not speculatively.
 */
export function SelectField({ label, id, required, error, children, helperText, ...selectProps }: SelectFieldProps) {
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-neutral-700">
        {label}
        {required ? (
          <span className="text-red-500" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </label>
      <div className="relative">
        <select
          id={id}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : helperText ? helperId : undefined}
          aria-required={required}
          className={`w-full appearance-none rounded-lg border bg-neutral-100 px-3.5 py-2.5 pr-9 text-sm text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 ${
            error ? "border-red-400" : "border-transparent"
          }`}
          {...selectProps}
        >
          {children}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : helperText ? (
        <p id={helperId} className="text-xs text-neutral-400">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
