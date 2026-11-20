import type { components } from "@jack/shared";

import { apiPost } from "@/lib/api";

// The interest list's one door to the API (#409): `POST /v1/interest`. It answers 202 with no
// body whether or not the email was already on the list, so any success is "on the list".

export const INTEREST_PATH = "/v1/interest";

/** What the list takes: the email, the page's language, the source and the consent's version. */
export type InterestJoin = components["schemas"]["InterestJoin"];

/**
 * Puts the email on the list. `forwarding` carries the web service's key and the visitor's
 * address (lib/public-form/visitor.ts), made on this server only. Throws ApiError on a refusal,
 * with its code and, on a 429, the API's Retry-After.
 */
export async function joinInterestList(body: InterestJoin, forwarding: Headers): Promise<void> {
  await apiPost(INTEREST_PATH, body, { headers: forwarding });
}
