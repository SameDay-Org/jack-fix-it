import { router } from "expo-router";
import { useEffect, useRef } from "react";

import { usePhoneStepOffered } from "./phoneFlow";

/**
 * For the screen at `/` (every home): right after a sign-up, opens the phone step over itself,
 * once. Returns true while the step is offered, so the caller shows only its bare page until then
 * and nothing shows through the push. Home stays under the step, so "Skip for now" and a verified
 * number both pop back to it (a gate redirect straight to the step would leave home out of the
 * stack).
 */
export function useOpenPhoneStepAfterSignUp(): boolean {
  const phoneStepOffered = usePhoneStepOffered();
  const opened = useRef(false);

  useEffect(() => {
    if (!phoneStepOffered || opened.current) return;
    opened.current = true;
    router.push("/verify-phone?from=sign-up");
  }, [phoneStepOffered]);

  return phoneStepOffered;
}
