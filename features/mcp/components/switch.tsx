"use client";

type SwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: "md" | "lg";
};

/**
 * An accessible on/off switch: a real <button role="switch"> with
 * aria-checked, so it is focusable, toggles with Space/Enter, and is
 * announced as a switch with its label. No switch existed in this app
 * yet; this one stays feature-local until a second feature needs it.
 */
export function Switch({ checked, onChange, label, disabled = false, size = "md" }: SwitchProps) {
  const track = size === "lg" ? "h-7 w-12" : "h-6 w-10";
  const knob = size === "lg" ? "h-5 w-5" : "h-4 w-4";
  const travel = size === "lg" ? "translate-x-6" : "translate-x-5";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex shrink-0 items-center rounded-full p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${track} ${
        checked ? "bg-gradient-to-r from-blue-600 to-violet-600" : "bg-neutral-300"
      }`}
    >
      <span
        aria-hidden="true"
        className={`${knob} rounded-full bg-white shadow-sm transition-transform ${checked ? travel : "translate-x-0"}`}
      />
    </button>
  );
}
