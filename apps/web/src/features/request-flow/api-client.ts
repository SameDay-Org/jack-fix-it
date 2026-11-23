import type { components } from "@jack/shared";

import { apiGet, apiPost } from "@/lib/api";

// The request flow's one door to the API (#86). Every call the flow makes is here, typed from
// the API's schema (packages/shared).

type Schemas = components["schemas"];

/** `POST /v1/web/requests`'s body (#86 API): the request, who to call and the consent. */
export type WebRequestCreate = Schemas["WebRequestIn"];

/** Its 201: only the code the visitor is shown, nothing echoed. */
export type WebRequestCreated = Schemas["WebRequestCreated"];

export const WEB_REQUESTS_PATH = "/v1/web/requests";

/** How long the services and the served areas are reused for every visitor: an hour. */
const CATALOG_REVALIDATE_SECONDS = 3600;

/** The active services and their questions, read once an hour for every visitor. */
export function activeCategories(): Promise<Schemas["CategoryOut"][]> {
  return apiGet("/v1/categories", { next: { revalidate: CATALOG_REVALIDATE_SECONDS } });
}

/** The served areas (region, cities, ZIPs), read once an hour for every visitor. */
export function servedAreas(): Promise<Schemas["RegionOut"][]> {
  return apiGet("/v1/service-areas", { next: { revalidate: CATALOG_REVALIDATE_SECONDS } });
}

/** Whether a ZIP is served, asked for one visitor (their address goes with it). */
export function servedCheck(zip: string, forwarding: Headers): Promise<Schemas["ServedCheckOut"]> {
  return apiGet("/v1/service-areas/check", {
    query: { zip },
    cache: "no-store",
    headers: forwarding,
  });
}

/** Joins the waitlist of an unserved ZIP (202, no body). */
export async function joinWaitlist(
  body: Schemas["WaitlistJoin"],
  forwarding: Headers,
): Promise<void> {
  await apiPost("/v1/waitlist", body, { headers: forwarding });
}

/**
 * Sends a web request (`POST /v1/web/requests`, #86): the form token's nonce as its
 * Idempotency-Key, so sending the same form again (a double press, an answer lost on the way)
 * answers the request the first call made. `forwarding` carries the web service's key and the
 * visitor's address (lib/public-form/visitor.ts), made on this server only. Throws ApiError on
 * a refusal, with its code and, on a 429, the API's Retry-After.
 */
export function createWebRequest(
  body: WebRequestCreate,
  idempotencyKey: string,
  forwarding: Headers,
): Promise<WebRequestCreated> {
  const headers = new Headers(forwarding);
  headers.set("Idempotency-Key", idempotencyKey);
  return apiPost(WEB_REQUESTS_PATH, body, { headers });
}
