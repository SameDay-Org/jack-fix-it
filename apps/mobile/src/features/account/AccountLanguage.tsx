import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

import { useSession } from "@/api";
import { activeLanguage, deviceLanguage, languageOf, setLanguage } from "@/i18n";

import { isSavingLocale } from "./api";

/** The account the app's language was last taken from, and the saved language it held then. */
type Followed = { account: string | null; locale: string | null };

/**
 * Keeps the app in the signed-in account's saved language, and in the device's when nobody is
 * signed in or the app is not written in the saved one (#218).
 *
 * - An account arrives (a restore at launch, a sign-in, another account): its saved language. It
 *   leaves: the device's.
 * - The same account, saved in another language since (changed on another device, learned at a
 *   token refresh): this device follows, as long as it was in step with the account. A device
 *   holding its own choice keeps it: one the server has not saved yet (Settings says so and
 *   offers to send it again), or one being saved right now, whose answers must not move the
 *   screen back and forth.
 *
 * In a layout effect, the step in which the session gate swaps the signed-out screens for the app
 * (`SessionGate`, mounted after this): both land in one update before anything is painted, so the
 * app's first frame is already in the account's language, and the screens on their way out are
 * removed, never redrawn in another language halfway through their exit (that redraw broke the
 * native view tree on Android).
 */
export function useAccountLanguage(): void {
  const { user } = useSession();
  const queryClient = useQueryClient();
  // Nobody at first: the app starts in the device's language.
  const followed = useRef<Followed>({ account: null, locale: null });

  useLayoutEffect(() => {
    const last = followed.current;
    const next: Followed = { account: user?.id ?? null, locale: user?.locale ?? null };
    if (last.account === next.account && last.locale === next.locale) return;
    followed.current = next;

    const saved = languageOf(next.locale);
    if (last.account !== next.account) {
      setLanguage(saved ?? deviceLanguage());
    } else if (saved && activeLanguage() === last.locale && !isSavingLocale(queryClient)) {
      setLanguage(saved);
    }
  }, [user, queryClient]);
}

/** Renders nothing. The root layout mounts it ahead of the screens, so its effect runs first. */
export function AccountLanguage() {
  useAccountLanguage();
  return null;
}
