import { useQuery, useQueryClient } from "@tanstack/react-query";
import { uuid } from "expo";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import {
  ApiError,
  isCurrentGeneration,
  NetworkError,
  sessionGeneration,
  useSessionGeneration,
} from "@/api";
import { customerJobQueryOptions, refreshCustomerJob } from "@/features/jobs/api";
import { proNames, type CustomerJob } from "@/features/jobs/phase";
import { parsePriceCents } from "@/features/opportunities/money";
import { paymentConfig } from "@/features/payments/config";
import { openPaymentSheet } from "@/features/payments/paymentSheet";
import { claimSheet } from "@/features/payments/sheetLock";
import { useDeadlinePassed } from "@/features/payments/useJobConfirmation";
import { formatLocale, formatMoneyExact } from "@/features/quotes/format";

import { rememberTip, sendTip, TIP_ERRORS, tipOf, type TipCreate, type TipOut } from "./api";

/** What the customer picked on the card: a preset, or a custom amount typed into the field. */
export type TipSelection = { kind: "percent"; percent: number } | { kind: "custom" };

/**
 * Why a tip did not go through, said calmly with "Try again" and "No tip": `declined` (the sheet
 * or the card refused it, or the API reported it failed), `offline` (no answer), `rateLimited`
 * (too many choices in a short time), `inProgress` (its payment, or another change of it, is under
 * way), `generic` (any other failure). `needsReview`: support has to look at the tip first, so the
 * card offers no choice. A failed tip never touches the job: it stays confirmed.
 */
export type TipFailure =
  "declined" | "offline" | "rateLimited" | "inProgress" | "needsReview" | "generic";

/** Where the custom amount stands: nothing wrong, not an amount, or outside the bounds. */
export type CustomProblem = "invalid" | "outOfRange" | null;

/**
 * `idle` (the choice is the customer's), `working` (asking the API, or the sheet is up),
 * `confirming` (the sheet took the payment; the API's answer has not reached the job yet),
 * `delayed` (still no answer when the wait ran out: it lands later, the card says so).
 */
export type TipPhase = "idle" | "working" | "confirming" | "delayed";

export type TipState = {
  tip: TipOut | null;
  selection: TipSelection | null;
  custom: string;
  customProblem: CustomProblem;
  /** The amount the Tip button pays: the server's preset, or the custom amount as typed. */
  amountCents: number | null;
  phase: TipPhase;
  failure: TipFailure | null;
  select: (selection: TipSelection) => void;
  changeCustom: (text: string) => void;
  pay: () => void;
  skip: () => void;
};

/** The API's last word on a tip: nothing is in flight once it is one of these. */
const SETTLED: ReadonlySet<TipOut["status"]> = new Set(["succeeded", "failed", "declined"]);

/** Whether a failed send may not have been settled, so its retry carries the same key. */
function undecided(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (error instanceof ApiError && (error.status === 429 || error.status >= 500))
  );
}

/** What the card says about a send that failed; null when the job's refreshed answer says it. */
function failureOf(error: unknown, choice: TipCreate): TipFailure | null {
  if (error instanceof NetworkError) return "offline";
  if (!(error instanceof ApiError)) return "generic";
  if (error.status === 429) return "rateLimited";
  if (error.status === 422) return choice.choice === "custom" ? null : "generic";
  if (error.status !== 409) return "generic";
  switch (error.code) {
    case TIP_ERRORS.notAvailable:
    case TIP_ERRORS.alreadyPaid:
      return null;
    case TIP_ERRORS.inProgress:
      return "inProgress";
    case TIP_ERRORS.needsReview:
      return "needsReview";
    default:
      return "generic";
  }
}

/** Whether the job is asked for again after a refusal: its tip moved on the server meanwhile. */
function refreshes(error: ApiError, choice: TipCreate): boolean {
  if (error.status === 422) return choice.choice === "percent";
  return (
    error.status === 409 &&
    (error.code === TIP_ERRORS.notAvailable ||
      error.code === TIP_ERRORS.alreadyPaid ||
      error.code === TIP_ERRORS.inProgress)
  );
}

/** The amount a selection pays: a preset's comes from the server, a custom one is as typed. */
function selectedCents(tip: TipOut, selection: TipSelection | null, custom: string): number | null {
  if (selection === null) return null;
  if (selection.kind === "percent") {
    return tip.options.presets.find((p) => p.percent === selection.percent)?.amount_cents ?? null;
  }
  return parsePriceCents(custom);
}

/**
 * The tip at confirmation (#273): the choice, the Payment Sheet for a tip to pay, and the wait for
 * the API's answer, every step pinned to the session that started it. The job's own `tip` is the
 * truth the card shows (succeeded, failed, declined, can_tip); the phase is derived from it and
 * from what this card has in flight.
 */
export function useTip(requestId: string, job: CustomerJob): TipState {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const generation = useSessionGeneration();
  const tip = tipOf(job);
  const status = tip?.status ?? null;
  const [selection, setSelection] = useState<TipSelection | null>(null);
  const [custom, setCustom] = useState("");
  const [customProblem, setCustomProblem] = useState<CustomProblem>(null);
  const [working, setWorking] = useState(false);
  const [localFailure, setLocalFailure] = useState<TipFailure | null>(null);
  // When the sheet took a payment: the wait for the API's answer starts there.
  const [paidAt, setPaidAt] = useState<number | null>(null);
  // The Idempotency-Key of the last choice sent, kept while its answer may still be unknown.
  const sentKey = useRef<{ body: string; key: string } | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const waiting = paidAt !== null && !SETTLED.has(status);
  const expired = useDeadlinePassed(waiting ? paidAt + paymentConfig.pollTimeoutMs : null);
  // While waiting, the job (which carries the tip) is asked for again every poll interval.
  useQuery({
    ...customerJobQueryOptions(requestId, generation),
    enabled: waiting && !expired,
    refetchInterval: waiting && !expired ? paymentConfig.pollIntervalMs : false,
  });

  // The tip landing after a payment from this card is felt and said, once per payment.
  const landed = paidAt !== null && status === "succeeded";
  const announced = useRef(false);
  useEffect(() => {
    if (!landed || !tip || announced.current) return;
    announced.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    AccessibilityInfo.announceForAccessibility(
      t("tips.done", {
        name: proNames(t, job).lead,
        amount: formatMoneyExact(tip.amount_cents, formatLocale(), tip.currency),
      }),
    );
  }, [landed, tip, job, t]);

  const phase: TipPhase = working
    ? "working"
    : waiting
      ? expired
        ? "delayed"
        : "confirming"
      : "idle";
  const failure =
    phase === "idle" ? (localFailure ?? (status === "failed" ? "declined" : null)) : null;

  async function send(choice: TipCreate) {
    const started = sessionGeneration();
    const current = () => mounted.current && isCurrentGeneration(started);
    const paying = choice.choice !== "none";
    // One sheet at a time, whichever card asks: a second ask is ignored.
    const release = paying ? claimSheet() : () => undefined;
    if (!release) return;
    setWorking(true);
    setLocalFailure(null);
    setPaidAt(null);
    announced.current = false;
    const body = JSON.stringify(choice);
    const kept = sentKey.current;
    const idempotencyKey = kept?.body === body ? kept.key : uuid.v4();
    sentKey.current = { body, key: idempotencyKey };
    try {
      const answer = await sendTip(requestId, choice, { generation: started, idempotencyKey });
      // Answered: the next send is a new choice, with a new key.
      sentKey.current = null;
      if (!current()) return;
      rememberTip(queryClient, requestId, started, answer.tip);
      if (!answer.sheet) return;
      const result = await openPaymentSheet(answer.sheet, {
        merchantName: t("brand.name"),
        stillWanted: current,
      });
      if (!current()) return;
      if (result.kind === "paid") {
        setPaidAt(Date.now());
        refreshCustomerJob(queryClient, requestId, started);
      } else if (result.kind === "failed") {
        setLocalFailure("declined");
      }
    } catch (error) {
      if (!undecided(error)) sentKey.current = null;
      if (!current()) return;
      setLocalFailure(failureOf(error, choice));
      if (error instanceof ApiError && refreshes(error, choice)) {
        // The window closed, a tip landed or is under way, or the presets changed meanwhile: the
        // job's answer says which.
        refreshCustomerJob(queryClient, requestId, started);
      }
      if (error instanceof ApiError && error.status === 422 && choice.choice === "custom") {
        setCustomProblem("outOfRange");
      }
    } finally {
      release();
      if (mounted.current) setWorking(false);
    }
  }

  const amountCents = tip ? selectedCents(tip, selection, custom) : null;

  function pay() {
    if (!tip || !selection || phase !== "idle") return;
    if (selection.kind === "percent") {
      void send({ choice: "percent", percent: selection.percent });
      return;
    }
    const cents = parsePriceCents(custom);
    if (cents === null) {
      setCustomProblem("invalid");
    } else if (cents < tip.options.min_cents || cents > tip.options.max_cents) {
      setCustomProblem("outOfRange");
    } else {
      void send({ choice: "custom", amount_cents: cents });
    }
  }

  function skip() {
    if (phase !== "idle") return;
    AccessibilityInfo.announceForAccessibility(t("tips.skipped"));
    void send({ choice: "none" });
  }

  function select(next: TipSelection) {
    setSelection(next);
    setLocalFailure(null);
    setCustomProblem(null);
  }

  function changeCustom(text: string) {
    setCustom(text);
    setCustomProblem(null);
  }

  return {
    tip,
    selection,
    custom,
    customProblem,
    amountCents,
    phase,
    failure,
    select,
    changeCustom,
    pay,
    skip,
  };
}
