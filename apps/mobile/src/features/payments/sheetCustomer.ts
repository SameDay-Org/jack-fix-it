import { resetPaymentSheetCustomer } from "@stripe/stripe-react-native";

import { onSignOut } from "@/api";

import { paymentConfig } from "./config";

/**
 * Stripe keeps the customer's sign-in to the Payment Sheet on the device (saved cards, Link) and
 * asks apps to reset it at logout. Every end of a session asks for a reset: a sign-out, an expired
 * session, another account signing in (`onSignOut`). Asking never blocks the sign-out.
 *
 * A sheet starts only once a reset has succeeded since the last one asked for. A reset that fails
 * keeps that cleanup owed: the next sheet tries it again (at most `resetAttempts` times) and, if it
 * still fails or takes longer than `resetTimeoutMs`, the sheet does not open and the card says the
 * payment could not start. A reset still waiting for Stripe is joined, never run twice at once;
 * when it answers, the owed cleanup is settled or tried again by the next sheet.
 *
 * Stripe's state survives a restart, and an account can change without a sign-out this app saw
 * (a restore that could not reach the server leaves no user in memory to compare the next
 * sign-in with). So the app also resets once at launch: the root layout imports this module,
 * which asks for that reset and registers the sign-out hook before any screen loads.
 */

/** How many resets were asked for: a sheet that sees it change belongs to an ended session. */
let requested = 0;
/** The resets a successful native reset covers: cleanup is owed while it trails `requested`. */
let cleared = 0;
/** The native reset running now; one at a time. */
let inFlight: Promise<void> | null = null;

/** Settles whenever the state above changes, so waiting sheets look again. */
let changed: Promise<void>;
let wake: () => void;
function renew(): void {
  changed = new Promise((resolve) => {
    wake = resolve;
  });
}
renew();
function notify(): void {
  const resolve = wake;
  renew();
  resolve();
}

function startReset(): void {
  const covers = requested;
  inFlight = Promise.resolve()
    .then(() => resetPaymentSheetCustomer())
    .then(
      () => {
        cleared = covers;
      },
      (error: unknown) => {
        // Cleanup stays owed. Only the error's class is logged; its text may come from the SDK.
        console.warn(
          `Payment sheet reset failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      },
    )
    .finally(() => {
      inFlight = null;
      if (requested > covers) startReset(); // a session ended while it ran
      notify();
    });
}

/** Asks Stripe to forget the session's customer; runs after any reset still running. */
export function resetSheetCustomer(): void {
  requested += 1;
  if (!inFlight) startReset();
  notify();
}

/**
 * Where a sheet may start: `ready` once a reset succeeded after every one asked for so far, with
 * `ended` saying whether another was asked for since (the session that opened it ended);
 * `ended` when that happens or `signal` aborts while waiting; `unavailable` when the owed reset
 * kept failing or did not answer within `resetTimeoutMs`. Only `ready` may open the sheet.
 */
export type SheetCustomer =
  { kind: "ready"; ended: () => boolean } | { kind: "ended" } | { kind: "unavailable" };

export async function sheetCustomerReady(signal?: AbortSignal): Promise<SheetCustomer> {
  const startedAt = requested;
  const ended = () => requested !== startedAt;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, paymentConfig.resetTimeoutMs);
  });
  const aborted = new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  let tries = 0;
  try {
    for (;;) {
      if (signal?.aborted || ended()) return { kind: "ended" };
      if (cleared >= requested) return { kind: "ready", ended };
      if (timedOut) return { kind: "unavailable" };
      if (!inFlight) {
        if (tries >= paymentConfig.resetAttempts) return { kind: "unavailable" };
        tries += 1;
        startReset();
      }
      await Promise.race([changed, deadline, aborted]);
    }
  } finally {
    clearTimeout(timer);
  }
}

resetSheetCustomer();
onSignOut(resetSheetCustomer);
