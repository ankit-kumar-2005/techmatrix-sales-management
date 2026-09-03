"use client";

import { PASSWORD_RULES } from "../schemas";

type PasswordRequirementsProps = {
  value: string;
};

/**
 * Live checklist of the password policy, driven by the same PASSWORD_RULES
 * the Zod schema validates against. Uses a check/circle glyph plus text
 * (not color alone) so it stays legible for colorblind users. See
 * CLAUDE.md accessibility guidance.
 */
export function PasswordRequirements({ value }: PasswordRequirementsProps) {
  return (
    <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(value);
        return (
          <li
            key={rule.id}
            className={`flex items-center gap-1.5 ${met ? "text-emerald-600" : "text-neutral-500"}`}
          >
            <span aria-hidden="true">{met ? "✓" : "○"}</span>
            <span>
              {rule.label}
              <span className="sr-only">{met ? " — met" : " — not met yet"}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
