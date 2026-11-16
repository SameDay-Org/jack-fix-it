import type { TFunction } from "i18next";

import { ApiError, NetworkError, type GetResponse } from "@/api";

/** The customer's saved cards as the API lists them: the most recently added first. */
export type Wallet = GetResponse<"/v1/me/payment-methods">;
/**
 * One saved card. All the app ever has of it: Stripe's id, the brand, the last four digits, the
 * expiry and whether it is the default. Never the number, the CVC or the cardholder.
 */
export type SavedCard = Wallet[number];

/** The brands the wallet draws a mark and writes a name for; any other brand is `generic`. */
export const KNOWN_BRANDS = ["visa", "mastercard", "amex", "discover"] as const;
export type CardBrand = (typeof KNOWN_BRANDS)[number] | "generic";

/** Stripe's brand as the wallet draws it. */
export const brandOf = (card: Pick<SavedCard, "brand">): CardBrand =>
  KNOWN_BRANDS.find((brand) => brand === card.brand) ?? "generic";

const twoDigits = (value: number) => String(value % 100).padStart(2, "0");

/** The expiry as cards print it: `MM/YY`. */
export const expiryOf = (card: Pick<SavedCard, "exp_month" | "exp_year">): string =>
  `${twoDigits(card.exp_month)}/${twoDigits(card.exp_year)}`;

/**
 * What the wallet shows of the number: four dots and the last four digits, joined by a no-break
 * space so a line never ends between the dots and the digits (large text, a long brand name).
 */
export const maskedNumber = (card: Pick<SavedCard, "last4">): string => `••••\u00a0${card.last4}`;

/** The card on one line, as its strip and the pocket's face write it: "Visa •••• 4242". */
export const cardName = (t: TFunction, card: SavedCard): string =>
  `${t(`paymentMethods.brand.${brandOf(card)}`)} ${maskedNumber(card)}`;

/**
 * The card as a screen reader says it, in full: "Visa ending 4242, expires 12 28, default". The
 * dots of the masked number are never read out.
 */
export function spokenCard(t: TFunction, card: SavedCard): string {
  const spoken = t("paymentMethods.spoken.card", {
    brand: t(`paymentMethods.brand.${brandOf(card)}`),
    last4: card.last4,
    month: twoDigits(card.exp_month),
    year: twoDigits(card.exp_year),
  });
  return card.is_default ? `${spoken}, ${t("paymentMethods.spoken.default")}` : spoken;
}

/** The card as a sentence names it (a toast, an announcement): "Visa ending 4242". */
export const shortSpokenCard = (t: TFunction, card: SavedCard): string =>
  t("paymentMethods.spoken.short", {
    brand: t(`paymentMethods.brand.${brandOf(card)}`),
    last4: card.last4,
  });

/**
 * A card's age in the wallet, 0 for the oldest. The API lists the newest first, so a card keeps its
 * age when the default moves or a card is added: its color (`cardTone`) stays with it.
 */
export function ageOf(wallet: Wallet, card: Pick<SavedCard, "id">): number {
  const index = wallet.findIndex((saved) => saved.id === card.id);
  return index < 0 ? 0 : wallet.length - 1 - index;
}

/** The wallet as the pocket stacks it: the default in front, then the API's order. */
export const walletOrder = (wallet: Wallet): Wallet => [
  ...wallet.filter((card) => card.is_default),
  ...wallet.filter((card) => !card.is_default),
];

/** The wallet with `id` as its one default. */
export const withDefault = (wallet: Wallet, id: string): Wallet =>
  wallet.map((card) =>
    card.is_default === (card.id === id) ? card : { ...card, is_default: card.id === id },
  );

/**
 * The wallet without the card. Who is the default next is the server's to say (the list fetched
 * after the delete): none is named here.
 */
export const withoutCard = (wallet: Wallet, id: string): Wallet =>
  wallet.filter((card) => card.id !== id);

/**
 * The card a successful add saved: the one of `after` that `before` did not have (the newest, if
 * there are several). None when the list does not show it.
 */
export function addedCard(before: Wallet, after: Wallet): SavedCard | undefined {
  const known = new Set(before.map((card) => card.id));
  return after.find((card) => !known.has(card.id));
}

/**
 * Why the wallet could not be read or changed, as the screens word it: `offline` (no answer),
 * `unavailable` (503: payments are not set up, or Stripe did not answer in time), `rateLimited`
 * (429), `gone` (404: the card is not in the wallet anymore), `generic` (anything else).
 */
export type WalletFailure = "offline" | "unavailable" | "rateLimited" | "gone" | "generic";

export function walletFailure(error: unknown): WalletFailure {
  if (error instanceof NetworkError) return "offline";
  if (!(error instanceof ApiError)) return "generic";
  if (error.status === 503) return "unavailable";
  if (error.status === 429) return "rateLimited";
  if (error.status === 404 && error.code === "payment_method_not_found") return "gone";
  return "generic";
}
