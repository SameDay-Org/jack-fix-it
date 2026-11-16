import { useCallback, useEffect, useRef, useState } from "react";

import { useSessionGeneration } from "@/api";

import { payoutsFailure, useCreateOnboardingLink, type PayoutsFailure } from "./api";
import { closeSetupPage, openSetupPage } from "./browser";
import type { PayoutsReturn } from "./links";

export type PayoutSetup = {
  /** Asks for a setup link and opens it; a press while one is under way does nothing. */
  start: () => void;
  /** From the press until the pro is back and the status is in again. */
  busy: boolean;
  /** Why the setup page did not open, until the next press or a status with nothing to set up. */
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
 * Leaving the screen ends it: a link not yet answered is cancelled and opens nothing, and a page
 * already open is closed where the system allows it. `settable` is whether the status still has
 * a setup to offer: without one, what a press came to (an expired link, a page that did not open)
 * has nothing to say, now or later.
 */
export function usePayoutSetup(settable: boolean): PayoutSetup {
  const generation = useSessionGeneration();
  // Whether the setup page is open now: only an open page is closed when the screen goes away.
  const pageOpen = useRef(false);
  const openPage = useCallback(async (url: string) => {
    pageOpen.current = true;
    try {
      return await openSetupPage(url);
    } finally {
      pageOpen.current = false;
    }
  }, []);
  const { mutate, reset, isPending, error, data } = useCreateOnboardingLink(openPage);
  // An expired link that arrived as a route, not as the browser session's answer.
  const [expiredLink, setExpiredLink] = useState(false);

  // Adjusted while rendering: a status with nothing to set up forgets the expired link.
  if (!settable && expiredLink) setExpiredLink(false);

  // The same for what the last press came to (its exit, its failure): once the status moves on,
  // a later "more information needed" starts clean. Never while a press is under way: a reset
  // detaches it, and its end (which frees the button) would go unheard. A pending press holds no
  // data and no error yet, so `pressLeftSomething` already rules it out; `!isPending` is kept as
  // a deliberate second guard that says so outright.
  const pressLeftSomething = data !== undefined || error !== null;
  useEffect(() => {
    if (!settable && !isPending && pressLeftSomething) reset();
  }, [settable, isPending, pressLeftSomething, reset]);

  // The press under way, if any: also what stops two taps in one frame (the button only shows
  // busy from the next render on).
  const leaving = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    if (leaving.current !== null) return;
    const controller = new AbortController();
    leaving.current = controller;
    setExpiredLink(false);
    mutate(
      { generation, signal: controller.signal },
      {
        onSettled: () => {
          leaving.current = null;
        },
      },
    );
  }, [generation, mutate]);

  useEffect(
    () => () => {
      leaving.current?.abort();
      if (pageOpen.current) closeSetupPage();
    },
    [],
  );

  const onReturnLink = useCallback((result: PayoutsReturn) => {
    setExpiredLink(result === "refresh");
  }, []);

  return {
    start,
    busy: isPending,
    failure: error ? payoutsFailure(error) : null,
    expired: settable && !isPending && !error && (expiredLink || data === "refresh"),
    onReturnLink,
  };
}
