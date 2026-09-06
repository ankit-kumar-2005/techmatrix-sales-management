"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

type FormFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  /** Shows a "required" marker next to the label. Purely visual — actual
   *  validation is handled by the form's Zod schema, not native HTML
   *  validation (forms use noValidate). */
  required?: boolean;
  /** Optional leading icon rendered inside the input, left-aligned. */
  icon?: ReactNode;
  /** "outline" (default, used everywhere) or "filled" — a borderless,
   *  light-gray-background input for forms that ask for that specific
   *  look (e.g. Create Lead). Kept as an explicit variant rather than a
   *  trailing className override so it can't silently lose a Tailwind
   *  class-ordering fight against the default border/background. */
  variant?: "outline" | "filled";
};

export function FormField({
  label,
  error,
  id,
  required,
  icon,
  variant = "outline",
  className,
  ...inputProps
}: FormFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  const inputClassName =
    variant === "filled"
      ? `w-full rounded-lg border border-transparent bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-colors focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60 ${
          icon ? "pl-10" : ""
        } ${error ? "ring-2 ring-red-300" : ""} ${className ?? ""}`
      : `w-full rounded-lg border px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:hover:border-neutral-300 ${
          icon ? "pl-10" : ""
        } ${error ? "border-red-400 hover:border-red-400" : "border-neutral-300 hover:border-neutral-400"} ${
          className ?? ""
        }`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-neutral-700">
        {label}
        {required ? (
          <span className="text-red-500" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </label>
      <div className="relative">
        {icon ? (
          <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-neutral-400">
            {icon}
          </span>
        ) : null}
        <input
          id={inputId}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          aria-required={required}
          className={inputClassName}
          {...inputProps}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
