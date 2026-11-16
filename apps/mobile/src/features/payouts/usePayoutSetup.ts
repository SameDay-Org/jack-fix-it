import { useCallback, useRef, useState } from "react";

import { useSessionGeneration } from "@/api";

import { payoutsFailure, useCreateOnboardingLink, type PayoutsFailure } from "./api";
import { openSetupPage } from "./browser";
import type { PayoutsReturn } from "./links";

export type PayoutSetup = {
  /** Asks for a setup link and opens it; a press while one is under way does nothing. */
  start: () => void;
  /** From the press until the pro is back and the status is in again. */
  busy: boolean;
  /** Why the setup page did not open, until the next press. */
  failure: PayoutsFailure | null;
  /** The pro came back through an expired or used link: the next press opens a new one. */
  expired: boolean;
  /** A return link reached the app outside the browser session (`/pro/payouts?result=…`). */
  onReturnLink: (result: PayoutsReturn) => void;
};

/**
 * "Set up payouts" (#277): one press asks the API for a single-use link and opens Stripe's page
 * with it, for the session the press was made in. The app never opens a second link by itself:
 * an expired one says so and waits for the next press (each link is a rate-limited Stripe call).
 */
export function usePayoutSetup(): PayoutSetup {
  const generation = useSessionGeneration();
  const { mutate, isPending, error, data } = useCreateOnboardingLink(openSetupPage);
  // An expired link that arrived as a route, not as the browser session's answer.
  const [expiredLink, setExpiredLink] = useState(false);

  // Two taps in one frame: the button only shows busy from the next render on.
  const opening = useRef(false);

  const start = useCallback(() => {
    if (opening.current) return;
    opening.current = true;
    setExpiredLink(false);
    mutate(
      { generation },
      {
        onSettled: () => {
          opening.current = false;
        },
      },
    );
  }, [generation, mutate]);

  const onReturnLink = useCallback((result: PayoutsReturn) => {
    setExpiredLink(result === "refresh");
  }, []);

  return {
    start,
    busy: isPending,
    failure: error ? payoutsFailure(error) : null,
    expired: !isPending && !error && (expiredLink || data === "refresh"),
    onReturnLink,
  };
}
