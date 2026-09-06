"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type ScrollFadeInProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Wraps a section so it fades/slides in once it enters the viewport,
 * instead of a scroll animation library — purely presentational, no
 * effect on the content it wraps.
 */
export function ScrollFadeIn({ children, className }: ScrollFadeInProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`motion-reduce:translate-y-0 motion-reduce:opacity-100 transition-all duration-700 ease-out ${
        isVisible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      } ${className ?? ""}`}
    >
      {children}
    </div>
  );
}
