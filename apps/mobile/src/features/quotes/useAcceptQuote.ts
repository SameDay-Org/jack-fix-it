import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import { apiPost, ApiError, SessionExpiredError } from "@/api";
import { showToast } from "@/components/ui";

import { quotesQueryKey, type CustomerQuote, type CustomerQuoteList } from "./useRequestQuotes";

/**
 * How an accept ended, for the confirmation: `accepted`; `notAcceptable` (409: expired,
 * withdrawn, another quote won, the pro can no longer be hired; or 404: the quote is gone);
 * `signedOut` (the session ended, its own screens take over); `failed` (offline, timeout, 5xx),
 * safe to try again since a repeated accept answers with the same quote.
 */
export type AcceptOutcome = "accepted" | "notAcceptable" | "signedOut" | "failed";

function outcomeOf(error: unknown): Exclude<AcceptOutcome, "accepted"> {
  if (error instanceof SessionExpiredError) return "signedOut";
  if (error instanceof ApiError && (error.status === 409 || error.status === 404)) {
    return "notAcceptable";
  }
  return "failed";
}

/** The cached list with the accepted quote in its place, as the API will list it next. */
const withAccepted = (list: CustomerQuoteList, accepted: CustomerQuote): CustomerQuoteList => ({
  items: list.items.map((quote) => (quote.id === accepted.id ? accepted : quote)),
});

/**
 * Accepts one quote of the request. The answer goes into the cached list at once, so the screen
 * shows the accepted state as the sheet closes, and the list is refetched after any answer (a 409
 * means it changed). What the customer is told happens here, not in the caller, so it is told
 * even when the confirmation was swiped away before the answer: screen readers hear an accept,
 * a toast says a quote can no longer be accepted, and a failure the closed sheet cannot show
 * becomes a toast too. `onDone` (closing the sheet, showing a failure in it) runs only while the
 * caller is still mounted, and a second call while one is in flight is ignored, however fast the
 * taps.
 */
export function useAcceptQuote(requestId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mutation = useMutation({
    mutationFn: (quoteId: string) =>
      apiPost("/v1/requests/{request_id}/quotes/{quote_id}/accept", undefined, {
        auth: true,
        params: { request_id: requestId, quote_id: quoteId },
      }),
    onSuccess: (accepted) => {
      queryClient.setQueryData<CustomerQuoteList>(
        quotesQueryKey(requestId),
        (list) => list && withAccepted(list, accepted),
      );
      AccessibilityInfo.announceForAccessibility(t("quotes.acceptedNote"));
    },
    onError: (error) => {
      const outcome = outcomeOf(error);
      if (outcome === "notAcceptable") {
        showToast({ message: t("quotes.notAcceptable"), tone: "danger" });
      } else if (outcome === "failed" && !mounted.current) {
        showToast({ message: t("quotes.confirm.failed"), tone: "danger" });
      }
    },
    // Not awaited: the mutation would hold its answer (and the busy button) until the refetch lands.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: quotesQueryKey(requestId) });
    },
  });
  const { mutate } = mutation;

  const accept = useCallback(
    (quoteId: string, onDone: (outcome: AcceptOutcome) => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      mutate(quoteId, {
        onSuccess: () => onDone("accepted"),
        onError: (error) => onDone(outcomeOf(error)),
        onSettled: () => {
          inFlight.current = false;
        },
      });
    },
    [mutate],
  );

  return { accept, sending: mutation.isPending };
}
