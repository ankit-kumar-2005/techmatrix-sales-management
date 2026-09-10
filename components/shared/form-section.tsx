import type { ReactNode } from "react";

const ACCENT_CLASSES = {
  teal: "bg-teal-50 text-teal-700 ring-teal-100",
  sky: "bg-sky-50 text-sky-600 ring-sky-100",
} as const;

type FormSectionProps = {
  icon: ReactNode;
  title: string;
  accent?: keyof typeof ACCENT_CLASSES;
  children: ReactNode;
};

/**
 * A small icon chip + uppercase heading above a group of related
 * fields, with a divider above every section but the first — for
 * forms with enough fields to benefit from visual grouping (a short
 * form doesn't need this at all; see NewCatalogItemDialog for a
 * two-section example and AddTaskDialog for a three-section one).
 * `accent` lets each feature keep its own established color identity
 * (teal for Catalog, sky for Tasks/Leads) rather than one fixed color
 * imposed on every consumer.
 */
export function FormSection({ icon, title, accent = "sky", children }: FormSectionProps) {
  return (
    <div className="flex flex-col gap-4 border-t border-neutral-100 pt-5 first:mt-0 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ${ACCENT_CLASSES[accent]}`}>
          {icon}
        </span>
        <h3 className="text-xs font-semibold tracking-wider text-neutral-500 uppercase">{title}</h3>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}
