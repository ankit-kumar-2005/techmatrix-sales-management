const PLACEHOLDER_LOGOS = [
  "Nimbus & Co",
  "Vertex Group",
  "Bluewave Inc.",
  "Norda Systems",
  "Crestline Partners",
  "Ashcroft & Sons",
  "Solstice Labs",
  "Harborview",
];

/**
 * Placeholder wordmarks for a pre-launch product — invented, generic
 * company names, not real customers. Swap in real client logos once
 * they're available; until then this only demonstrates the layout.
 */
export function LogoMarquee() {
  return (
    <div className="border-y border-neutral-100 bg-[#F7F9FC] py-10">
      <p className="mx-auto max-w-6xl px-4 text-center text-xs font-semibold uppercase tracking-wide text-neutral-400 sm:px-6 lg:px-8">
        Trusted by sales teams at
      </p>

      <div
        className="relative mt-6 overflow-hidden"
        style={{
          maskImage: "linear-gradient(to right, transparent, black 20%, black 80%, transparent)",
          WebkitMaskImage: "linear-gradient(to right, transparent, black 20%, black 80%, transparent)",
        }}
      >
        <div className="animate-marquee flex w-max items-center gap-16">
          {[...PLACEHOLDER_LOGOS, ...PLACEHOLDER_LOGOS].map((name, index) => (
            <span
              key={`${name}-${index}`}
              className="shrink-0 text-xl leading-none font-bold tracking-tight text-neutral-400 transition-colors duration-200 hover:text-sky-600"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
