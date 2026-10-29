/** Basis points in a whole: a take rate of 1500 bps is 15%. */
export const BPS_DENOMINATOR = 10_000;
const CENTS_PER_DOLLAR = 100;
const CENT_DIGITS = 2;

/**
 * The largest amount the API accepts (`amount_cents` is a 32-bit column, `le=INT4_MAX` in
 * `QuoteCreate`). The platform may set a lower cap; the server enforces it (422).
 */
export const MAX_AMOUNT_CENTS = 2_147_483_647;

/** What the pro receives and what the platform keeps of an amount. */
export type Split = { proPayoutCents: number; platformFeeCents: number };

/**
 * The server's `split_amount` (`apps/api/app/money.py`), for the form's live preview: the fee is
 * the amount times the take rate, rounded half up to the cent, and the payout is the rest, so the
 * two always add up to the amount. Integer arithmetic only. The server's answer is the truth
 * once the quote is sent.
 */
export function split(amountCents: number, takeRateBps: number): Split {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new RangeError("amountCents must be a non-negative integer");
  }
  if (!Number.isInteger(takeRateBps) || takeRateBps < 0 || takeRateBps > BPS_DENOMINATOR) {
    throw new RangeError("takeRateBps must be an integer from 0 to 10000");
  }
  const fee = Math.floor((amountCents * takeRateBps + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR);
  return { proPayoutCents: amountCents - fee, platformFeeCents: fee };
}

// Dollars with optional thousands separators ("1,000" or "1000") and up to two decimals. The
// whole part is bounded so the cents stay exact integers; anything that large is past the cap.
const PRICE = /^(\d{1,3}(?:,\d{3}){0,4}|\d{1,13})(?:\.(\d{0,2}))?$/;

/**
 * A typed price in integer cents: "100" → 10000, "100.5" → 10050, "1,000.00" → 100000. Built
 * from the digits, never through a float, so no amount drifts by a cent. `null` when the text is
 * not a price (empty, letters, a misplaced comma, three decimals).
 */
export function parsePriceCents(text: string): number | null {
  const match = PRICE.exec(text.trim());
  if (match === null) return null;
  const [, whole = "", fraction = ""] = match;
  const dollars = Number(whole.replace(/,/g, ""));
  const cents = Number(fraction.padEnd(CENT_DIGITS, "0"));
  return dollars * CENTS_PER_DOLLAR + cents;
}

/** Cents as the field shows them after editing: "1,000.00", always two decimals, no symbol. */
export function priceText(cents: number): string {
  const dollars = Math.floor(cents / CENTS_PER_DOLLAR);
  const rest = String(cents % CENTS_PER_DOLLAR).padStart(CENT_DIGITS, "0");
  return `${dollars.toLocaleString("en-US")}.${rest}`;
}
