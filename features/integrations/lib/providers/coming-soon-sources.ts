/**
 * DISPLAY (AND NOW SCHEMA) ONLY — never the backend. This type is still
 * never imported by `types/integration.ts` or `registry.ts`, and the
 * webhook route still has no adapter for any of these three, so a real
 * inbound push for one still 404s exactly as an unknown source always
 * has (confirmed against the route's own code before any row for these
 * three was ever created — see docs/automations.md's Lead Capture
 * section... actually see this feature's own PR notes: Phase 0 of this
 * pass specifically re-read app/api/webhooks/leads/[source]/[token]/
 * route.ts to confirm `getLeadProviderAdapter(source)` is checked
 * BEFORE any database read or write, for both GET and POST, so an
 * unregistered source can never reach `ingest_lead()` at all).
 *
 * WHAT CHANGED FROM THE PREVIOUS PASS: these three now get a REAL
 * `customer_integrations` row and a real, stored, unique webhook
 * token — provisioned automatically (see ensure-coming-soon-
 * integrations.ts), through the exact same insert
 * connectIndiamartAction already uses, just parameterized by source
 * name. The URL a "Soon" card shows is therefore genuinely real and
 * copyable; it simply has nothing listening on the other end of it
 * yet. `IntegrationSource` (types/integration.ts) remains "the only
 * place the set of ADAPTER-BACKED sources is closed" — widening THAT
 * union, or adding an entry to `LEAD_PROVIDER_REGISTRY`, is still the
 * one thing that would actually make the webhook route accept traffic
 * for one of these, and this file still never touches either.
 */
export type ComingSoonSource = "JustDial" | "Website" | "Meta";

export type ComingSoonSourceMetadata = {
  /** Also the exact string stored in this row's `customer_integrations.source`
   *  column — same convention IndiaMART's own row already uses (the
   *  display name, verbatim, not a separate slug). */
  source: ComingSoonSource;
  displayName: string;
  /** Badge text — "" for Website, which gets an icon instead (see
   *  `useGlobeIcon` below); a generic category has no company to take
   *  initials from the way JustDial/Meta do. */
  initials: string;
  useGlobeIcon?: boolean;
  /** Short line under the name — always visible, same slot IndiaMART's
   *  real description sits in. */
  description: string;
  /** Best-effort draft of what the real setup steps will probably look
   *  like, in the same numbered-step voice as IndiaMART's real panel.
   *  Written from public knowledge of each platform's own dashboard,
   *  not verified against a real integration — the panel's own closing
   *  line says so explicitly. */
  setupSteps: string[];
};

export const COMING_SOON_SOURCES: ComingSoonSourceMetadata[] = [
  {
    source: "JustDial",
    displayName: "JustDial",
    initials: "JD",
    description: "Buyer enquiries pushed from your JustDial seller dashboard.",
    setupSteps: [
      "In your JustDial seller dashboard, look for a Leads or Enquiries section with an API/integration option.",
      "JustDial will likely ask for a single callback URL, similar to IndiaMART's Push API — that's the URL above.",
      "Once this is live, a test enquiry will appear under Recently captured, the same way it does for IndiaMART.",
    ],
  },
  {
    source: "Website",
    displayName: "Website",
    initials: "",
    useGlobeIcon: true,
    description: "Leads submitted through your own website's contact or enquiry form.",
    setupSteps: [
      "Point your website's contact/enquiry form at the URL above as its submission endpoint, instead of (or in addition to) emailing you.",
      "If your site is built on a platform like WordPress or Webflow, this is usually a \"webhook\" or \"custom action\" field in the form's settings.",
      "A real submission will need to send at least a name and one contact detail — the exact fields this expects will be documented once this is live.",
    ],
  },
  {
    source: "Meta",
    displayName: "Meta",
    initials: "M",
    description: "Leads captured from Facebook and Instagram lead ads.",
    setupSteps: [
      "In Meta Business Suite, open the Instant Forms / Lead Ads settings for your Page.",
      "Meta's own setup is a bit more involved than IndiaMART's — it typically needs a connected app and a verification step, not just a pasted URL.",
      "Once live, this will most likely connect through Meta's Lead Ads webhook subscription rather than a simple copy-paste callback like the others.",
    ],
  },
];
