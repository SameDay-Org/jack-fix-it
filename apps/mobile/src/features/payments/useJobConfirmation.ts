import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import { refreshCustomerJob } from "@/features/jobs/api";
import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

import { paymentConfig } from "./config";
import { stopConfirming, useConfirming } from "./paymentStore";
import { useRequestJob, type CustomerJob } from "./useRequestJob";

/**
 * Where the accepted quote's payment stands: `loading` (first look at the job), `unpaid` (no job:
 * Pay; also when the look failed, since paying again is safe), `confirming` (the sheet reported a
 * payment and the job is not there yet), `delayed` (still no job when the wait ran out), `booked`
 * (the job exists: the webhook confirmed the payment; the card says "Paid").
 */
export type PaymentPhase = "loading" | "unpaid" | "confirming" | "delayed" | "booked";

/** True once `deadline` (ms since the epoch) has passed; false while it is null. */
function useDeadlinePassed(deadline: number | null): boolean {
  // Already past when the card mounts (back after the wait ran out): delayed from the first frame.
  const [passed, setPassed] = useState<number | null>(() =>
    deadline !== null && deadline <= Date.now() ? deadline : null,
  );

  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(() => setPassed(deadline), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);

  return deadline !== null && passed === deadline;
}

/**
 * Follows the request's job for the accepted quote's card. After the sheet reports a payment it
 * asks for the job every `pollIntervalMs`, only while the screen is in front and for at most
 * `pollTimeoutMs`, with every call pinned to the payment's session; a sign-out forgets the wait
 * and the cache, which ends it. The job showing up ends the wait, is announced and felt (a
 * success haptic), and the request's own notice above the quotes (#64) is told to ask for it. The
 * job is also asked for again whenever the screen comes back into focus or the app returns to
 * the foreground, so a delayed confirmation still lands.
 */
export function useJobConfirmation(
  requestId: string,
  quoteId: string,
): { phase: PaymentPhase; job: CustomerJob | null | undefined } {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirming = useConfirming(quoteId);
  const focused = useIsFocused();
  const expired = useDeadlinePassed(
    confirming ? confirming.since + paymentConfig.pollTimeoutMs : null,
  );
  const polling = confirming !== undefined && focused && !expired;
  const {
    data: job,
    isError,
    refetch,
  } = useRequestJob(requestId, {
    pollMs: polling ? paymentConfig.pollIntervalMs : false,
    generation: confirming?.generation,
  });
  useRefetchOnReturn(refetch);

  // A new wait asks at once, through the observer that now carries the payment's session, if the
  // screen is in front: a payment reported behind another screen is asked for by the return to
  // focus (`useRefetchOnReturn`), so the focus is read here without re-running the effect on it.
  const focusedNow = useRef(focused);
  useEffect(() => {
    focusedNow.current = focused;
  }, [focused]);
  const since = confirming?.since;
  useEffect(() => {
    if (since !== undefined && focusedNow.current) void refetch();
  }, [since, refetch]);

  const booked = Boolean(job);
  useEffect(() => {
    if (!booked || confirming === undefined) return;
    stopConfirming(quoteId);
    // The notice asked before the payment and found no job; it is not polled, so it is told.
    void refreshCustomerJob(queryClient, requestId);
    AccessibilityInfo.announceForAccessibility(t("payment.booked.announcement"));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }, [booked, confirming, queryClient, quoteId, requestId, t]);

  const phase: PaymentPhase = job
    ? "booked"
    : confirming
      ? expired
        ? "delayed"
        : "confirming"
      : job === null || isError
        ? "unpaid"
        : "loading";
  return { phase, job };
}
