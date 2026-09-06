"use client";

import { useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@/features/sales-management/components/icons";

type Testimonial = {
  quote: string;
  name: string;
  role: string;
  company: string;
  accent: "sky" | "teal" | "amber" | "violet";
};

const AVATAR_ACCENTS = {
  sky: "bg-sky-100 text-sky-700",
  teal: "bg-teal-100 text-teal-700",
  amber: "bg-amber-100 text-amber-700",
  violet: "bg-violet-100 text-violet-700",
} as const;

/**
 * Placeholder testimonials for a pre-launch product — invented names and
 * companies (not real customers) to demonstrate the layout. Replace with
 * real customer feedback once it exists.
 */
const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "Techmatrix gave our team one clear view of the pipeline instead of five different spreadsheets. Follow-ups don't fall through the cracks anymore.",
    name: "Alex Morgan",
    role: "Sales Director",
    company: "Nimbus & Co",
    accent: "sky",
  },
  {
    quote:
      "Rolling out role-based access took minutes, not weeks. Our reps only see what they need, and managers finally have real visibility into the team.",
    name: "Priya Nair",
    role: "VP of Sales",
    company: "Vertex Group",
    accent: "teal",
  },
  {
    quote:
      "The lead capture and pipeline views are exactly what our team needed — simple, fast, and built around how we actually sell.",
    name: "Daniel Osei",
    role: "Sales Operations Manager",
    company: "Bluewave Inc.",
    accent: "amber",
  },
  {
    quote:
      "It feels like it was actually designed for a sales team, not adapted from a generic CRM. Setup was straightforward and the team adopted it fast.",
    name: "Maria Gomez",
    role: "Head of Revenue",
    company: "Crestline Partners",
    accent: "violet",
  },
];

function initialsFor(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function TestimonialCarousel() {
  const [index, setIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (isPaused) return;
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % TESTIMONIALS.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [isPaused, index]);

  const active = TESTIMONIALS[index];

  return (
    <div
      className="mx-auto max-w-3xl"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="flex items-center justify-center gap-4 sm:gap-6">
        <button
          type="button"
          onClick={() => setIndex((current) => (current - 1 + TESTIMONIALS.length) % TESTIMONIALS.length)}
          aria-label="Previous testimonial"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 transition-colors hover:border-sky-300 hover:text-sky-600"
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>

        <div
          aria-live="polite"
          className="min-h-[220px] flex-1 rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-black/5 sm:p-10"
        >
          <p className="text-lg leading-relaxed text-neutral-700">&ldquo;{active.quote}&rdquo;</p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <span
              className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold ${AVATAR_ACCENTS[active.accent]}`}
            >
              {initialsFor(active.name)}
            </span>
            <div className="text-left">
              <p className="text-sm font-semibold text-neutral-900">{active.name}</p>
              <p className="text-xs text-neutral-500">
                {active.role} · {active.company}
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIndex((current) => (current + 1) % TESTIMONIALS.length)}
          aria-label="Next testimonial"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 transition-colors hover:border-sky-300 hover:text-sky-600"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-6 flex items-center justify-center gap-2">
        {TESTIMONIALS.map((testimonial, dotIndex) => (
          <button
            key={testimonial.name}
            type="button"
            onClick={() => setIndex(dotIndex)}
            aria-label={`Show testimonial ${dotIndex + 1} of ${TESTIMONIALS.length}`}
            aria-current={dotIndex === index ? "true" : undefined}
            className={`h-2 rounded-full transition-all ${
              dotIndex === index ? "w-6 bg-sky-600" : "w-2 bg-neutral-300 hover:bg-neutral-400"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
