import { openAuthSessionAsync } from "expo-web-browser";

import { PAYOUTS_RETURN_URL, payoutsReturnResult, type PayoutsReturn } from "./links";

/**
 * How the pro left Stripe's setup page: through the API's return page (`return`: done or not,
 * the status says which), through its refresh page (`refresh`: the link expired or was already
 * used), or by closing the browser (`closed`).
 */
export type SetupExit = PayoutsReturn | "closed";

/**
 * Opens Stripe's hosted payout setup in a browser session over the app (the system's own:
 * `ASWebAuthenticationSession` on iOS, a Custom Tab on Android; never a web view of ours, so the
 * app cannot read what the pro types there) and resolves when the pro is back: the session ends
 * by itself on the app's return link. The link is passed to the browser and nowhere else.
 */
export async function openSetupPage(url: string): Promise<SetupExit> {
  const result = await openAuthSessionAsync(url, PAYOUTS_RETURN_URL);
  if (result.type !== "success") return "closed";
  return payoutsReturnResult(result.url) ?? "return";
}
