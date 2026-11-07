import { resetPaymentSheetCustomer } from "@stripe/stripe-react-native";

import { onSignOut } from "@/api";

/**
 * Stripe keeps the customer's sign-in to the Payment Sheet on the device (saved cards, Link) and
 * asks apps to reset it at logout. Every end of a session resets it: a sign-out, an expired
 * session, another account signing in (`onSignOut`). The next sheet waits for the resets asked
 * for before it starts, and a sheet that was still running when one was asked for asks again
 * once it ends, so nothing it saved outlives the session.
 *
 * Stripe's state survives a restart, and an account can change without a sign-out this app saw
 * (a restore that could not reach the server leaves no user in memory to compare the next
 * sign-in with). So the app also resets once at launch: the root layout imports this module,
 * which queues that reset and registers the sign-out hook before any screen loads.
 */

/** The resets asked for so far, run one after another; it never rejects. */
let queue: Promise<void> = Promise.resolve();
/** How many resets were asked for: a sheet that sees it change belongs to an ended session. */
let requested = 0;

async function runReset(): Promise<void> {
  try {
    await resetPaymentSheetCustomer();
  } catch (error) {
    // The sign-out goes on: the next session's sheet reinitializes with its own customer. Only
    // the error's class is logged; its text may come from the SDK.
    console.warn(`Payment sheet reset failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

/** Asks Stripe to forget the session's customer; queued behind any reset still running. */
export function resetSheetCustomer(): void {
  requested += 1;
  queue = queue.then(runReset);
}

/**
 * Where a sheet starts: after every reset asked for so far has settled. `ended` then says
 * whether another reset was asked for since this call, i.e. the session that opened it ended.
 */
export async function sheetCustomerReady(): Promise<{ ended: () => boolean }> {
  const startedAt = requested;
  await queue;
  return { ended: () => requested !== startedAt };
}

resetSheetCustomer();
onSignOut(resetSheetCustomer);
