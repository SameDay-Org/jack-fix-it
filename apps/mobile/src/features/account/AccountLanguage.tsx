import { useLayoutEffect, useRef } from "react";

import { useSession } from "@/api";
import { deviceLanguage, languageOf, setLanguage } from "@/i18n";

/**
 * Keeps the app in the signed-in account's saved language, and in the device's when nobody is
 * signed in or the app is not written in the saved one (#218). It follows the account, not each
 * copy of it: the saved language is applied when an account arrives (a restore at launch, a
 * sign-in, another account) and the device's when it leaves. In between the language on screen is
 * the person's to change (Settings), and a choice the server has not saved yet stays on this
 * device until then.
 *
 * In a layout effect, the step in which the session gate swaps the signed-out screens for the app
 * (`SessionGate`): both land in one update before anything is painted, so the app's first frame
 * is already in the account's language, and the screens on their way out are removed, never
 * redrawn in another language halfway through their exit (that redraw broke the native view
 * tree on Android).
 */
export function useAccountLanguage(): void {
  const { user } = useSession();
  // The account the language was last set for; nobody at first: the app starts in the device's.
  const followed = useRef<string | null>(null);

  useLayoutEffect(() => {
    const account = user?.id ?? null;
    if (followed.current === account) return;
    followed.current = account;
    setLanguage(languageOf(user?.locale) ?? deviceLanguage());
  }, [user]);
}

/** Renders nothing. The root layout mounts it ahead of the screens, so its effect runs first. */
export function AccountLanguage() {
  useAccountLanguage();
  return null;
}
