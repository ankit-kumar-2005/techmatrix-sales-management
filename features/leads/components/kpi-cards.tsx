"use client";

import { useRef, useState, type ReactNode } from "react";

export type KpiCardAccent = {
  /** Diagonal gradient wash, e.g. "from-white to-sky-50" — deepens via gradientHover on hover. */
  gradient: string;
  gradientHover: string;
  iconBg: string;
  iconText: string;
  iconRing: string;
  /** Soft colored glow behind the icon chip, e.g. "shadow-md shadow-sky-200/70". */
  iconGlow: string;
};

export type KpiCardData = {
  label: string;
  value: string;
  caption: string;
  /** Pre-rendered icon element, not a component reference — this is a
   *  Client Component receiving props from a Server Component parent,
   *  and only rendered elements (not raw component values) can safely
   *  cross that boundary. */
  icon: ReactNode;
  accent: KpiCardAccent;
};

type KpiCardsProps = {
  cards: KpiCardData[];
};

/**
 * Same 4 cards, same order, same data — just two presentations of them.
 * md and up: the existing static grid (unchanged layout). Below md: a
 * horizontally swipeable, scroll-snap carousel (each card ~85% width so
 * the next one peeks in) with dot pagination, since a 4-column grid
 * doesn't comfortably fit a phone screen. The dots track scroll position
 * via a plain onScroll listener — a visual aid, not a source of truth
 * for anything, so it doesn't need to be pixel-perfect.
 */
export function KpiCards({ cards }: KpiCardsProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  function handleScroll() {
    const el = scrollerRef.current;
    if (!el || cards.length === 0) return;
    const cardWidth = el.scrollWidth / cards.length;
    const index = Math.round(el.scrollLeft / cardWidth);
    setActiveIndex(Math.min(cards.length - 1, Math.max(0, index)));
  }

  return (
    <div>
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        tabIndex={0}
        role="group"
        aria-label="Key metrics"
        className="flex gap-4 overflow-x-auto pb-1 [-ms-overflow-style:none] [scroll-snap-type:x_mandatory] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:grid md:grid-cols-2 md:gap-4 md:overflow-visible md:pb-0 lg:grid-cols-4"
      >
        {cards.map((card) => (
          <div
            key={card.label}
            className={`group w-[85%] shrink-0 rounded-2xl bg-gradient-to-br ${card.accent.gradient} ${card.accent.gradientHover} p-6 shadow-sm ring-1 ring-black/5 transition-all duration-200 ease-out [scroll-snap-align:start] hover:-translate-y-0.5 hover:shadow-lg hover:ring-black/10 md:w-auto md:shrink`}
          >
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">{card.label}</p>
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 transition-colors duration-150 ${card.accent.iconBg} ${card.accent.iconText} ${card.accent.iconRing} ${card.accent.iconGlow}`}
              >
                {card.icon}
              </span>
            </div>
            <p
              className={`mt-4 text-3xl font-bold tracking-tight ${
                card.value === "—" ? "text-neutral-300" : "text-neutral-900"
              }`}
            >
              {card.value}
            </p>
            <p className="mt-1.5 text-xs text-neutral-500">{card.caption}</p>
          </div>
        ))}
      </div>

      {/* Dot pagination — mobile-only, purely visual. */}
      <div className="mt-3 flex justify-center gap-1.5 md:hidden">
        {cards.map((card, index) => (
          <span
            key={card.label}
            aria-hidden="true"
            className={`h-1.5 rounded-full transition-all duration-200 ${
              index === activeIndex ? "w-4 bg-blue-600" : "w-1.5 bg-neutral-300"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
