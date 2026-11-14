import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import {
  apiPost,
  ApiError,
  isCurrentGeneration,
  NetworkError,
  SessionExpiredError,
  sessionGeneration,
} from "@/api";
import { showToast } from "@/components/ui";
import { invalidateMyRequests } from "@/features/history/useMyRequests";
import { refreshCustomerJob } from "@/features/jobs/api";
import { formatMoney } from "@/features/quotes/format";
import { quotesQueryKey } from "@/features/quotes/useRequestQuotes";

import { openPaymentSheet, type SheetResult } from "./paymentSheet";
import { rememberSummary, startConfirming } from "./paymentStore";
import { jobQueryKey } from "./useRequestJob";

/**
 * Why a payment did not start or did not go through, for the card to say calmly; Pay stays.
 * From the API: `offline` (no answer), `notConfigured` (503 not_configured), `needsReview` (409
 * payment_needs_review: support resolves it), `proNotHireable` (409 pro_not_hireable), `generic`
 * (any other failure: 502, 503, 5xx). From the sheet: `sheetFailed`, `sheetTimeout`,
 * `sheetUnavailable` (it could not open).
 */
export type PayFailure =
  | "offline"
  | "notConfigured"
  | "needsReview"
  | "proNotHireable"
  | "generic"
  | "sheetFailed"
  | "sheetTimeout"
  | "sheetUnavailable";

export type PayState = { busy: boolean; failure: PayFailure | null };

const IDLE: PayState = { busy: false, failure: null };

const SHEET_FAILURES: Record<Extract<SheetResult, { kind: "failed" }>["reason"], PayFailure> = {
  failed: "sheetFailed",
  timeout: "sheetTimeout",
  unavailable: "sheetUnavailable",
};

// Stripe shows one sheet at a time, whichever card or flow asks: a second ask while one is being
// prepared or shown is ignored.
let sheetInUse = false;

function refreshQuotes(queryClient: QueryClient, requestId: string): void {
  void queryClient.invalidateQueries({ queryKey: quotesQueryKey(requestId) });
  void queryClient.invalidateQueries({ queryKey: jobQueryKey(requestId) });
  // The quote may have been paid elsewhere: the request's notice (#64) looks for the job as well.
  refreshCustomerJob(queryClient, requestId, sessionGeneration());
  void invalidateMyRequests(queryClient);
}

/**
 * Pays for the accepted quote: asks the API for the sheet (`POST …/payment`, safe to repeat: the
 * same PaymentIntent with a new ephemeral key), opens Stripe's Payment Sheet, and records a
 * payment the sheet reports as done so the card can confirm it (`startConfirming`). Every step
 * belongs to the session the tap started in: after a sign-out or another sign-in nothing more is
 * sent or opened, and a late answer changes nothing. The sheet only opens while the card is still
 * mounted. The total is announced as it arrives, before the sheet covers the screen. A 409 that
 * means the quote changed (`payment_not_available`, or a 404: the quote is gone) refreshes the
 * quotes and says so in a toast; canceling the sheet says nothing.
 */
export function usePayQuote(requestId: string, quoteId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [state, setState] = useState<PayState>(IDLE);
  const mounted = useRef(true);
  // Ends a payment still waiting for Stripe's reset when the card goes away (`openPaymentSheet`).
  const leaving = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      leaving.current?.abort();
    };
  }, []);

  const show = useCallback((next: PayState) => {
    if (mounted.current) setState(next);
  }, []);

  const failFromApi = useCallback(
    (error: unknown) => {
      if (error instanceof SessionExpiredError) return show(IDLE); // the session's screens take over
      if (error instanceof NetworkError) return show({ busy: false, failure: "offline" });
      if (!(error instanceof ApiError)) return show({ busy: false, failure: "generic" });
      if (
        error.status === 404 ||
        (error.status === 409 && error.code === "payment_not_available")
      ) {
        refreshQuotes(queryClient, requestId);
        showToast({ message: t("payment.notAvailable"), tone: "danger" });
        return show(IDLE);
      }
      if (error.status === 409 && error.code === "pro_not_hireable") {
        refreshQuotes(queryClient, requestId);
        return show({ busy: false, failure: "proNotHireable" });
      }
      if (error.status === 409 && error.code === "payment_needs_review") {
        return show({ busy: false, failure: "needsReview" });
      }
      if (error.status === 503 && error.code === "not_configured") {
        return show({ busy: false, failure: "notConfigured" });
      }
      return show({ busy: false, failure: "generic" });
    },
    [queryClient, requestId, show, t],
  );

  /** Starts a payment; `generation` pins it to the session an earlier step started in (accept). */
  const pay = useCallback(
    async (generation: number = sessionGeneration()) => {
      if (sheetInUse || !isCurrentGeneration(generation)) return;
      sheetInUse = true;
      show({ busy: true, failure: null });
      const current = () => isCurrentGeneration(generation);
      const controller = new AbortController();
      leaving.current = controller;
      try {
        let sheet;
        try {
          sheet = await apiPost("/v1/requests/{request_id}/quotes/{quote_id}/payment", undefined, {
            auth: true,
            generation,
            params: { request_id: requestId, quote_id: quoteId },
          });
        } catch (error) {
          if (current()) failFromApi(error);
          return;
        }
        if (!current()) return;
        rememberSummary(quoteId, sheet);
        AccessibilityInfo.announceForAccessibility(
          t("payment.summaryAnnouncement", { total: formatMoney(sheet.customer_total_cents) }),
        );

        const result = await openPaymentSheet(sheet, {
          merchantName: t("brand.name"),
          stillWanted: () => mounted.current && current(),
          signal: controller.signal,
        });
        // Paid for another account's session: nothing of it is shown to this one.
        if (!current()) return;
        if (result.kind === "paid") {
          startConfirming(quoteId, { since: Date.now(), generation }); // the card asks for the job
          show(IDLE);
        } else if (result.kind === "failed") {
          show({ busy: false, failure: SHEET_FAILURES[result.reason] });
        } else {
          show(IDLE); // canceled, or the card went away before the sheet opened
        }
      } finally {
        if (leaving.current === controller) leaving.current = null;
        sheetInUse = false;
        if (!current()) show(IDLE);
      }
    },
    [failFromApi, quoteId, requestId, show, t],
  );

  return { ...state, pay };
}
