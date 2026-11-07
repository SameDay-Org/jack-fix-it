import * as Haptics from "expo-haptics";
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";

import { paymentConfig } from "./config";
import { stopConfirming, useConfirming } from "./paymentStore";
import { useRequestJob, type CustomerJob } from "./useRequestJob";

/**
 * Where the accepted quote's payment stands: `loading` (first look at the job), `unpaid` (no job:
 * Pay; also when the look failed, since paying again is safe), `confirming` (the sheet reported a
 * payment and the job is not there yet), `delayed` (still no job when the wait ran out), `booked`
 * (the job exists: the webhook confirmed the payment).
 */
export type PaymentPhase = "loading" | "unpaid" | "confirming" | "delayed" | "booked";

/** True once `deadline` (ms since the epoch) has passed; false while it is null. */
function useDeadlinePassed(deadline: number | null): boolean {
  const [passed, setPassed] = useState<number | null>(null);

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
 * success haptic). The job is also asked for again whenever the screen comes back into focus or
 * the app returns to the foreground, so a delayed confirmation still lands.
 */
export function useJobConfirmation(
  requestId: string,
  quoteId: string,
): { phase: PaymentPhase; job: CustomerJob | null | undefined } {
  const { t } = useTranslation();
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

  // A new wait asks at once, through the observer that now carries the payment's session.
  const since = confirming?.since;
  useEffect(() => {
    if (since !== undefined) void refetch();
  }, [since, refetch]);

  const booked = Boolean(job);
  useEffect(() => {
    if (!booked || confirming === undefined) return;
    stopConfirming(quoteId);
    AccessibilityInfo.announceForAccessibility(t("payment.booked.announcement"));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }, [booked, confirming, quoteId, t]);

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
