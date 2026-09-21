import type { IntegrationSource } from "@/types/integration";
import type { LeadProviderAdapter } from "./provider.interface";
import { indiaMartAdapter } from "./indiamart.adapter";

/**
 * THE ENTIRE "FACTORY". Adding a second source means adding one entry
 * here and one new *.adapter.ts file — nothing else in this file, and
 * nothing at all in the webhook controller or ingest_lead().
 *
 * Keyed by IntegrationSource, not a bare string — INTEGRATION_SOURCES
 * (types/integration.ts) is the closed list of sources this app knows
 * about, and typing this object against it means TypeScript itself
 * refuses to compile if that list is ever widened without a matching
 * adapter being registered here. No class hierarchy, no dynamic
 * require() — a plain object is the whole mechanism.
 */
const LEAD_PROVIDER_REGISTRY: Record<IntegrationSource, LeadProviderAdapter> = {
  IndiaMART: indiaMartAdapter,
};

/**
 * Looks up an adapter by an UNTRUSTED string — the webhook route's
 * `:source` URL segment is whatever an outside caller put there, not
 * something already known to be a real IntegrationSource. Returns null
 * for anything unregistered, which the route turns into the same
 * generic 404 an unknown token gets — an unauthenticated caller must
 * not be able to tell "this source doesn't exist" from "this source
 * exists but that token is wrong" by trying source names.
 */
export function getLeadProviderAdapter(source: string): LeadProviderAdapter | null {
  return (LEAD_PROVIDER_REGISTRY as Record<string, LeadProviderAdapter>)[source] ?? null;
}
