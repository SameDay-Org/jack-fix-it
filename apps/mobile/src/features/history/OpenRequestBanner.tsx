import { useInfiniteQuery } from "@tanstack/react-query";
import type { Href } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useSession } from "@/api";
import { AccessoryBanner } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";

import { pickOpenRequest, requestBannerParts } from "./openRequest";
import { myRequestsQueryOptions, type RequestSummary } from "./useMyRequests";

const requestHref = (requestId: string): Href => ({
  pathname: "/requests/[id]",
  params: { id: requestId },
});

export type OpenRequestState = {
  /** The request the banner shows, or null. */
  request: RequestSummary | null;
  refetch: () => Promise<unknown>;
};

/**
 * The open request for the tabs' banner (#474), from the same list History shows (one cache, no
 * second call when History has it). Asked for only while `wanted` (no job banner takes the place)
 * and for a signed-in customer; a pro has no requests.
 */
export function useOpenRequest(wanted: boolean): OpenRequestState {
  const { status, user } = useSession();
  const enabled = wanted && status === "signedIn" && user?.role === "customer";
  const { data, refetch } = useInfiniteQuery({ ...myRequestsQueryOptions(), enabled });
  const request = enabled ? pickOpenRequest(data?.pages[0]?.items ?? []) : null;
  // `refetch` runs even on a disabled query: never for a pro, or under a job banner.
  const refresh = useCallback(() => (enabled ? refetch() : Promise.resolve()), [enabled, refetch]);
  return { request, refetch: refresh };
}

/**
 * The tabs' line about a request still before its job (#474): "Jack is finding a pro", or "Quote
 * ready · compare" with the action in green. A tap opens the request's quotes. The job banner
 * takes this place once a job exists.
 */
export function OpenRequestBanner({ request }: { request: RequestSummary }) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const parts = requestBannerParts(t, request);
  return (
    <AccessoryBanner
      main={parts.main}
      tail={parts.tail}
      tailIsAction
      accessibilityLabel={parts.label}
      accessibilityHint={t("history.customer.banner.hint")}
      onPress={() => push(requestHref(request.id))}
      testID="request-banner"
    />
  );
}
