import { dismissAuthSession, openAuthSessionAsync } from "expo-web-browser";
import { Platform } from "react-native";

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
 * by itself on the app's return link. The link is passed to the browser and nowhere else: a
 * browser that would not open throws `SetupPageError`, never the module's own error, which the
 * caller would keep and which could quote the link.
 */
export async function openSetupPage(url: string): Promise<SetupExit> {
  let result: Awaited<ReturnType<typeof openAuthSessionAsync>>;
  try {
    result = await openAuthSessionAsync(url, PAYOUTS_RETURN_URL);
  } catch {
    throw new SetupPageError();
  }
  if (result.type !== "success") return "closed";
  return payoutsReturnResult(result.url) ?? "return";
}

/** The setup page did not open. It says nothing else: not the link, not the browser's reason. */
export class SetupPageError extends Error {
  constructor() {
    super("The payout setup page did not open");
    this.name = "SetupPageError";
  }
}

/**
 * Closes the setup page when the screen that opened it is gone (a sign-out under the browser):
 * the next person on the phone does not find it over the app. iOS only: Android gives an app no
 * way to close a Custom Tab, which is its own entry in Recents. Never throws.
 */
export function closeSetupPage(): void {
  if (Platform.OS !== "ios") return;
  try {
    dismissAuthSession();
  } catch {
    // Nothing was open.
  }
}
