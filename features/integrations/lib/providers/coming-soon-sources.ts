/**
 * DISPLAY-ONLY. This type and its data are NEVER imported by
 * `types/integration.ts`, `registry.ts`, `ingest-lead.ts`, or the
 * webhook route — deliberately. `IntegrationSource` (types/integration.ts)
 * is "the only place the set of [real] sources is closed"; widening it
 * would force real adapters into `LEAD_PROVIDER_REGISTRY` just to keep
 * the build compiling, and a real adapter is what actually makes the
 * webhook route accept traffic for a source. Nothing here does that.
 *
 * These three exist purely to show that Lead Capture has more sources
 * on the way — a "Soon" card that expands to one or two plain
 * sentences, nothing more. No URL, no steps, no buttons: see
 * ComingSoonSourceCard's own header for why even a simplified version
 * of the real Connection panel was deliberately rejected here.
 */
export type ComingSoonSource = "JustDial" | "Website" | "Meta";

export type ComingSoonSourceMetadata = {
  displayName: string;
  /** Badge text — "" for Website, which gets an icon instead (see
   *  `useGlobeIcon` below); a generic category has no company to take
   *  initials from the way JustDial/Meta do. */
  initials: string;
  useGlobeIcon?: boolean;
  /** Short line under the name — always visible, same slot IndiaMART's
   *  real description sits in. */
  description: string;
  /** The ONLY expanded content, shown when the card is clicked — one
   *  or two plain sentences, no more: what this source will do once
   *  it exists, and that it's coming soon. Not a setup guide. */
  expandedNote: string;
};

export const COMING_SOON_SOURCES: ComingSoonSourceMetadata[] = [
  {
    displayName: "JustDial",
    initials: "JD",
    description: "Buyer enquiries pushed from your JustDial seller dashboard.",
    expandedNote:
      "Once available, JustDial enquiries will flow into your pipeline automatically, the same way IndiaMART's do today. This source is still on our roadmap and isn't connected yet.",
  },
  {
    displayName: "Website",
    initials: "",
    useGlobeIcon: true,
    description: "Leads submitted through your own website's contact or enquiry form.",
    expandedNote:
      "Once available, submissions from your own site's contact or enquiry form will arrive here as leads automatically. This source is still on our roadmap and isn't connected yet.",
  },
  {
    displayName: "Meta",
    initials: "M",
    description: "Leads captured from Facebook and Instagram lead ads.",
    expandedNote:
      "Once available, leads from your Facebook and Instagram ad campaigns will arrive here automatically. This source is still on our roadmap and isn't connected yet.",
  },
];
