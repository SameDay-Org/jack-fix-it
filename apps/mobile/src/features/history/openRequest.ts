import type { TFunction } from "i18next";

import type { RequestSummary } from "./useMyRequests";

type RequestStatus = RequestSummary["status"];

/**
 * Before a job exists: Jack has the request, or a pro has quoted it. Accepted (the payment comes
 * next) is left to the quote screen, and a paid one to the job banner; expired and cancelled are
 * over.
 */
const OPEN_STATUSES: ReadonlySet<RequestStatus> = new Set([
  "received",
  "reviewing",
  "finding_pro",
  "quote_ready",
]);

/**
 * The request the tabs' banner points at (#474): the newest with a quote ready (the customer has
 * something to do), otherwise the newest still open; null when there is none. `requests` come
 * newest first, as the API lists them.
 */
export function pickOpenRequest(requests: readonly RequestSummary[]): RequestSummary | null {
  return (
    requests.find((request) => request.status === "quote_ready") ??
    requests.find((request) => OPEN_STATUSES.has(request.status)) ??
    null
  );
}

export type RequestBannerParts = {
  /** The sentence, which may be cut short on a narrow line. */
  main: string;
  /** The action it ends with ("compare"), never cut; null when there is nothing to do. */
  tail: string | null;
  /** Both read together, for the screen reader. */
  label: string;
};

/**
 * The banner's line for an open request: short enough for a 320 dp line at the default text size
 * (the banner opens that one request, so it needs no name). Jack has it (received or being
 * reviewed), Jack is finding a pro, or a quote is ready to compare.
 */
export function requestBannerParts(t: TFunction, request: RequestSummary): RequestBannerParts {
  if (request.status === "quote_ready") {
    const main = t("history.customer.banner.quoteReady");
    const tail = t("history.customer.banner.compare");
    return { main, tail, label: `${main} · ${tail}` };
  }
  const main = t(
    request.status === "finding_pro"
      ? "history.customer.banner.findingPro"
      : "history.customer.banner.received",
  );
  return { main, tail: null, label: main };
}
