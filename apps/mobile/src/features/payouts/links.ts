/**
 * Where Stripe's hosted payout setup sends the pro back to (#277). The API's return and refresh
 * pages redirect the browser to its `PAYOUTS_ONBOARDING_APP_URL` with `?result=return` (the pro
 * left the page, done or not) or `?result=refresh` (the link expired or was already used). This
 * is that URL: the app's scheme (`scheme` in app.config.ts) and the path below. It lives here,
 * not with the screen, so the link handler loads neither the browser module nor the API.
 */
export const PAYOUTS_RETURN_PATH = "payouts";
export const PAYOUTS_RETURN_URL = `jackfixit://${PAYOUTS_RETURN_PATH}`;

/** The payout status screen. */
export const PAYOUTS_ROUTE = "pro/payouts";
export const PAYOUTS_HREF = "/pro/payouts";

/** How the setup page was left, as the API's pages say it. */
export type PayoutsReturn = "return" | "refresh";

const RESULT = /[?&]result=(return|refresh)(?:[&#]|$)/;

/** The `result` of a return link, or null when it carries none the app knows. */
export function payoutsReturnResult(url: string): PayoutsReturn | null {
  const match = RESULT.exec(url);
  return match ? (match[1] as PayoutsReturn) : null;
}

/**
 * Whether a link's path (after the app's prefix) is the return from payout setup: exactly
 * `payouts`, with or without a trailing slash, a query or a fragment.
 */
export function isPayoutsReturn(rest: string): boolean {
  const end = rest.search(/[?#]/);
  const path = end === -1 ? rest : rest.slice(0, end);
  return path === PAYOUTS_RETURN_PATH || path === `${PAYOUTS_RETURN_PATH}/`;
}

/**
 * The route such a link opens: the payout status screen, with the `result` when it is one the
 * app knows. Anyone can write this link, so nothing else of it is kept.
 */
export function payoutsReturnRoute(rest: string): string {
  const result = payoutsReturnResult(rest);
  return result === null ? PAYOUTS_ROUTE : `${PAYOUTS_ROUTE}?result=${result}`;
}
