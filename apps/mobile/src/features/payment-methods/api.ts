import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import {
  apiDelete,
  apiGet,
  apiPost,
  isCurrentGeneration,
  SessionExpiredError,
  sessionGeneration,
} from "@/api";
import { showToast } from "@/components/ui";
// The two modules alone: the payments barrel brings the quote's whole payment panel with it.
import { openSetupSheet, type SetupResult } from "@/features/payments/paymentSheet";
import { claimSheet } from "@/features/payments/sheetLock";

import {
  addedCard,
  shortSpokenCard,
  walletFailure,
  withDefault,
  withoutCard,
  type SavedCard,
  type Wallet,
  type WalletFailure,
} from "./cards";

/** The wallet's place in the cache. No card detail is ever part of a key. */
export const PAYMENT_METHODS_QUERY_KEY = ["payment-methods"] as const;
const WALLET = { queryKey: PAYMENT_METHODS_QUERY_KEY, exact: true } as const;
/** Every change of the wallet (default, delete, add) runs under this one key. */
const WALLET_CHANGE_KEY = ["payment-methods", "change"] as const;

/**
 * The customer's saved cards (#253): what Stripe keeps, as the API lists it (brand, last four
 * digits, expiry, default). A failure is shown with a retry, not retried behind a skeleton. The
 * cache is the session's: a sign-out clears it. `enabled: false` asks nothing.
 */
export const usePaymentMethods = ({ enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: PAYMENT_METHODS_QUERY_KEY,
    queryFn: ({ signal }): Promise<Wallet> =>
      apiGet("/v1/me/payment-methods", { auth: true, signal }),
    retry: false,
    enabled,
  });

/*
 * The wallet's changes. One runs at a time: while one is unanswered a second is not started (its
 * button is off, and the action itself refuses), so the wallet on screen is never drawn from two
 * guesses. Each belongs to the session it was asked in (`generation`): its request is never sent
 * for another one, and its answer touches nothing once that session is gone. Set default and
 * Delete show on the wallet at once and leave it if the server refuses; either way the wallet is
 * listed again afterwards, and that list is what stays on screen.
 */

const changing = (client: QueryClient) => client.isMutating({ mutationKey: WALLET_CHANGE_KEY }) > 0;

/** Whether a change of the wallet is unanswered: no other one starts meanwhile. */
export const useWalletBusy = (): boolean => useIsMutating({ mutationKey: WALLET_CHANGE_KEY }) > 0;

type ChangeVariables = { card: SavedCard; generation: number };
/** The wallet as it was, and as the change drew it; none when no wallet was cached to draw on. */
type ChangeContext = { before: Wallet; shown: Wallet } | undefined;

/** Draws a change on the cached wallet before the server answers, for the session that asked. */
async function showChange(
  client: QueryClient,
  generation: number,
  edit: (wallet: Wallet) => Wallet,
): Promise<ChangeContext> {
  if (!isCurrentGeneration(generation)) return undefined;
  // A list asked before the change would draw over it when it lands.
  await client.cancelQueries(WALLET);
  if (!isCurrentGeneration(generation)) return undefined;
  const before = client.getQueryData<Wallet>(PAYMENT_METHODS_QUERY_KEY);
  if (!before) return undefined;
  // As the cache keeps it (it shares what did not change with `before`): `undoChange` tells its
  // own drawing by identity.
  const shown = client.setQueryData<Wallet>(PAYMENT_METHODS_QUERY_KEY, edit(before));
  return shown && { before, shown };
}

/**
 * Takes a refused change back. Only from the wallet the change itself drew: a list that landed
 * since is the server's word already, and a cache cleared by a sign-out stays empty.
 */
function undoChange(client: QueryClient, context: ChangeContext): void {
  if (!context) return;
  if (client.getQueryData(PAYMENT_METHODS_QUERY_KEY) !== context.shown) return;
  client.setQueryData<Wallet>(PAYMENT_METHODS_QUERY_KEY, context.before);
}

/** Lists the wallet again after a change, for the session that asked. */
function refreshWallet(client: QueryClient, generation: number): void {
  if (isCurrentGeneration(generation)) void client.invalidateQueries(WALLET);
}

/**
 * Says why a change did not stick. A toast, since the sheet that asked has closed; for the
 * session that asked only.
 */
function toastFailure(
  t: TFunction,
  error: unknown,
  action: "setDefault" | "delete",
  { card, generation }: ChangeVariables,
): void {
  if (!isCurrentGeneration(generation) || error instanceof SessionExpiredError) return;
  const failure = walletFailure(error);
  const message =
    failure === "generic"
      ? t(`paymentMethods.failed.${action}`, { card: shortSpokenCard(t, card) })
      : t(`paymentMethods.failed.${failure}`);
  showToast({ message, tone: "danger" });
}

/**
 * Makes a card the default (POST …/default): it carries the Default mark at once, and loses it if
 * the server refuses. Returns the action, `setDefault(card)`: false when it did not start because
 * another change of the wallet is unanswered.
 */
export function useSetDefaultCard() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { mutate } = useMutation<SavedCard, unknown, ChangeVariables, ChangeContext>({
    mutationKey: WALLET_CHANGE_KEY,
    mutationFn: ({ card, generation }) =>
      apiPost("/v1/me/payment-methods/{payment_method_id}/default", undefined, {
        auth: true,
        generation,
        params: { payment_method_id: card.id },
      }),
    onMutate: ({ card, generation }) =>
      showChange(client, generation, (wallet) => withDefault(wallet, card.id)),
    onSuccess: (saved, { generation }) => {
      if (!isCurrentGeneration(generation)) return;
      client.setQueryData<Wallet>(
        PAYMENT_METHODS_QUERY_KEY,
        (wallet) => wallet && withDefault(wallet, saved.id),
      );
      AccessibilityInfo.announceForAccessibility(
        t("paymentMethods.madeDefault", { card: shortSpokenCard(t, saved) }),
      );
    },
    onError: (error, variables, context) => {
      undoChange(client, context);
      toastFailure(t, error, "setDefault", variables);
    },
    onSettled: (_saved, _error, { generation }) => refreshWallet(client, generation),
  });
  return useCallback(
    (card: SavedCard): boolean => {
      if (changing(client)) return false;
      void Haptics.selectionAsync();
      mutate({ card, generation: sessionGeneration() });
      return true;
    },
    [client, mutate],
  );
}

/**
 * Deletes a card (DELETE): it leaves the wallet at once and comes back if the server refuses. One
 * already gone (`payment_method_not_found`, deleted on another device) counts as deleted. When it
 * was the default, the next default is the server's choice: the list fetched afterwards shows it.
 * Returns the action, `deleteCard(card)`: false when it did not start because another change of
 * the wallet is unanswered.
 */
export function useDeleteCard() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { mutate } = useMutation<undefined, unknown, ChangeVariables, ChangeContext>({
    mutationKey: WALLET_CHANGE_KEY,
    mutationFn: async ({ card, generation }) => {
      try {
        await apiDelete("/v1/me/payment-methods/{payment_method_id}", undefined, {
          auth: true,
          generation,
          params: { payment_method_id: card.id },
        });
      } catch (error) {
        if (walletFailure(error) !== "gone") throw error;
      }
      return undefined;
    },
    onMutate: ({ card, generation }) =>
      showChange(client, generation, (wallet) => withoutCard(wallet, card.id)),
    onSuccess: (_answer, { card, generation }) => {
      if (!isCurrentGeneration(generation)) return;
      AccessibilityInfo.announceForAccessibility(
        t("paymentMethods.deleted", { card: shortSpokenCard(t, card) }),
      );
    },
    onError: (error, variables, context) => {
      undoChange(client, context);
      toastFailure(t, error, "delete", variables);
    },
    onSettled: (_answer, _error, { generation }) => refreshWallet(client, generation),
  });
  return useCallback(
    (card: SavedCard): boolean => {
      if (changing(client)) return false;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      mutate({ card, generation: sessionGeneration() });
      return true;
    },
    [client, mutate],
  );
}

/**
 * Why a card was not added, for the screen to say calmly. Before the sheet: `offline`,
 * `unavailable` (503), `rateLimited`, `generic`. From the sheet: `sheetFailed` (Stripe could not
 * save the card), `sheetTimeout`, `sheetUnavailable` (it could not open).
 */
export type AddFailure =
  Exclude<WalletFailure, "gone"> | "sheetFailed" | "sheetTimeout" | "sheetUnavailable";

const SHEET_FAILURES: Record<Extract<SetupResult, { kind: "failed" }>["reason"], AddFailure> = {
  failed: "sheetFailed",
  timeout: "sheetTimeout",
  unavailable: "sheetUnavailable",
};

/**
 * How an add ended: `saved` (and whether the default rule could not be applied), `failed` with
 * why, or `idle`: the customer closed the sheet, the screen or the session went away, or another
 * Stripe sheet was up. Nothing of Stripe's secrets is in it.
 */
type AddOutcome =
  | { kind: "saved"; defaultFailed: boolean }
  | { kind: "failed"; failure: AddFailure }
  | { kind: "idle" };

const IDLE: AddOutcome = { kind: "idle" };

type AddVariables = {
  generation: number;
  /** The wallet as listed when Add was tapped: the card it lacks afterwards is the new one. */
  before: Wallet | undefined;
  merchantName: string;
  stillWanted: () => boolean;
  signal: AbortSignal;
};

/**
 * After Stripe saved a card: lists the wallet again and, when no card is the default, makes the
 * new one the default (the API never does that by itself). False when a card is saved but that
 * rule could not be applied: the wallet had no default and could not be listed, or the default call
 * was refused.
 */
async function settleNewCard(
  client: QueryClient,
  { generation, before }: Pick<AddVariables, "generation" | "before">,
): Promise<boolean> {
  const current = () => isCurrentGeneration(generation);
  try {
    // A list asked before the card was saved would draw over the new one when it lands.
    await client.cancelQueries(WALLET);
    const wallet = await apiGet("/v1/me/payment-methods", { auth: true, generation });
    if (!current()) return true;
    client.setQueryData<Wallet>(PAYMENT_METHODS_QUERY_KEY, wallet);
    if (wallet.some((card) => card.is_default)) return true;
    const added = addedCard(before ?? [], wallet);
    if (!added) return true;
    const saved = await apiPost("/v1/me/payment-methods/{payment_method_id}/default", undefined, {
      auth: true,
      generation,
      params: { payment_method_id: added.id },
    });
    if (!current()) return true;
    client.setQueryData<Wallet>(
      PAYMENT_METHODS_QUERY_KEY,
      (listed) => listed && withDefault(listed, saved.id),
    );
    return true;
  } catch {
    // Another account's by now, or a wallet that had its default before the add: nothing is owed.
    return !current() || !!before?.some((card) => card.is_default);
  }
}

/**
 * Adds a card: asks the API for a SetupIntent, opens Stripe's sheet in setup mode with it, and
 * after a save applies the default rule (`settleNewCard`). The card's number, expiry and CVC are
 * typed into Stripe's sheet and go to Stripe: this code sees how the sheet ended, nothing else,
 * and keeps neither secret of the SetupIntent past the call that opens the sheet.
 */
async function addCard(client: QueryClient, variables: AddVariables): Promise<AddOutcome> {
  const { generation, merchantName, stillWanted, signal } = variables;
  const current = () => isCurrentGeneration(generation);
  // One Stripe sheet at a time in the app, a payment's included.
  const release = claimSheet();
  if (!release) return IDLE;
  let result: SetupResult;
  try {
    const setup = await apiPost("/v1/me/payment-methods/setup-intent", undefined, {
      auth: true,
      generation,
    });
    if (!current()) return IDLE;
    result = await openSetupSheet(setup, {
      merchantName,
      stillWanted: () => stillWanted() && current(),
      signal,
    });
  } catch (error) {
    if (!current() || error instanceof SessionExpiredError) return IDLE;
    const failure = walletFailure(error);
    return { kind: "failed", failure: failure === "gone" ? "generic" : failure };
  } finally {
    release();
  }
  // Saved for another account's session: nothing of it is shown to this one.
  if (!current()) return IDLE;
  if (result.kind === "failed") return { kind: "failed", failure: SHEET_FAILURES[result.reason] };
  if (result.kind !== "saved") return IDLE;
  return { kind: "saved", defaultFailed: !(await settleNewCard(client, variables)) };
}

/**
 * Add a card, for the wallet's screen: `add()` starts it (ignored while any change of the wallet
 * is unanswered), `adding` is true until it ends, `failure` says why the last try did not save a
 * card (cleared by the next try). Closing the sheet changes nothing and says nothing. The sheet
 * only opens while the screen is still there; a card Stripe saved is listed and given the default
 * rule even if the screen has gone since.
 */
export function useAddCard() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [failure, setFailure] = useState<AddFailure | null>(null);
  const mounted = useRef(true);
  // Ends an add still waiting for Stripe's reset when the screen goes away (`openSetupSheet`).
  const leaving = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      leaving.current?.abort();
    };
  }, []);

  const { mutate, isPending } = useMutation<AddOutcome, never, AddVariables>({
    mutationKey: WALLET_CHANGE_KEY,
    mutationFn: (variables) => addCard(client, variables),
    onSuccess: (outcome, { generation }) => {
      if (!isCurrentGeneration(generation)) return;
      if (outcome.kind === "failed") {
        if (mounted.current) setFailure(outcome.failure);
        return;
      }
      if (outcome.kind !== "saved") return;
      showToast(
        outcome.defaultFailed
          ? { message: t("paymentMethods.add.savedNotDefault"), tone: "neutral" }
          : { message: t("paymentMethods.add.saved"), tone: "success" },
      );
      // Whatever the steps after the save could draw, the wallet is listed once more.
      refreshWallet(client, generation);
    },
  });

  const add = useCallback(() => {
    if (changing(client)) return;
    setFailure(null);
    const controller = new AbortController();
    leaving.current = controller;
    mutate({
      generation: sessionGeneration(),
      before: client.getQueryData<Wallet>(PAYMENT_METHODS_QUERY_KEY),
      merchantName: t("brand.name"),
      stillWanted: () => mounted.current,
      signal: controller.signal,
    });
  }, [client, mutate, t]);

  return { add, adding: isPending, failure };
}
