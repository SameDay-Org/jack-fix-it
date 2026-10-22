import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import { ApiError, SessionExpiredError, setSessionUser } from "@/api";
import { showToast } from "@/components/ui";

import { sendCode, verifyCode } from "./api";
import { CODE_LENGTH, phoneConfig } from "./config";
import { describePhoneFailure } from "./errors";
import { toE164 } from "./phoneNumber";
import { useCountdown } from "./useCountdown";
import { useUnmountSignal } from "./useUnmountSignal";

export type CodeEntry = {
  code: string;
  /** Digits only; the sixth one submits on its own. */
  setCode: (digits: string) => void;
  error: string | null;
  verifying: boolean;
  submit: () => Promise<void>;
  /** Seconds until "Resend code" works again; 0 when it does. */
  resendIn: number;
  resending: boolean;
  resend: () => Promise<void>;
};

const INVALID_CODE = "invalid_code";

/**
 * The code step for the number a code was sent to (national digits): the code, sent as soon as it
 * is complete, a resend that waits `phoneConfig.resendSeconds` between codes, and errors mapped to
 * catalog text and announced. A wrong code is cleared so the next one can be typed straight away.
 * Neither the number nor the code is ever logged.
 *
 * One operation at a time: while a code is checked, edits are ignored and resend waits; while a
 * resend runs, digits can be typed but are held, and once it settles a complete code is checked,
 * once. Leaving the screen cancels whatever is in flight, and a late answer neither navigates,
 * toasts, announces nor writes the session.
 */
export function useCodeEntry(digits: string, onVerified: () => void): CodeEntry {
  const { t } = useTranslation();
  const { countryCode, resendSeconds } = phoneConfig;
  const phone = toE164(countryCode, digits);
  const [code, setCodeState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const countdown = useCountdown(resendSeconds);
  const unmountSignal = useUnmountSignal();
  const inFlight = useRef(false);
  const resendInFlight = useRef(false);
  // The code as typed, for the check that runs when a resend settles (state would be a render late).
  const codeNow = useRef("");
  const keepCode = (next: string) => {
    codeNow.current = next;
    setCodeState(next);
  };

  const fail = (message: string) => {
    setError(message);
    AccessibilityInfo.announceForAccessibility(message);
  };

  const check = async (candidate: string) => {
    if (inFlight.current || resendInFlight.current || candidate.length !== CODE_LENGTH) return;
    const signal = unmountSignal();
    inFlight.current = true;
    setVerifying(true);
    try {
      const user = await verifyCode(phone, candidate, signal);
      if (signal.aborted) return; // the user left: this flow is over
      setSessionUser(user);
      showToast({ message: t("phone.verified"), tone: "success" });
      onVerified();
    } catch (failure) {
      if (signal.aborted) return;
      // The session ended meanwhile: the gate is taking the user to welcome, nothing to say here.
      if (failure instanceof SessionExpiredError) return;
      if (failure instanceof ApiError && failure.code === INVALID_CODE) keepCode("");
      fail(t(describePhoneFailure(failure)));
    } finally {
      inFlight.current = false;
      if (!signal.aborted) setVerifying(false);
    }
  };

  const setCode = (next: string) => {
    if (inFlight.current) return; // the code being checked stays as it is
    keepCode(next);
    setError(null);
    // During a resend the digits wait; the resend checks them once it settles.
    if (next.length === CODE_LENGTH && !resendInFlight.current) void check(next);
  };

  const resend = async () => {
    if (countdown.remaining > 0 || resendInFlight.current || inFlight.current) return;
    const signal = unmountSignal();
    resendInFlight.current = true;
    setResending(true);
    // A new code is on its way: the field starts empty for it.
    const before = codeNow.current;
    keepCode("");
    setError(null);
    let restored = false;
    try {
      await sendCode(phone, signal);
      if (signal.aborted) return;
      countdown.restart();
      showToast({ message: t("phone.codeResent"), tone: "neutral" });
    } catch (failure) {
      if (signal.aborted) return;
      // No new code is coming: the one typed before is still good, unless something was typed since.
      if (codeNow.current === "" && before !== "") {
        keepCode(before);
        restored = true;
      }
      if (!(failure instanceof SessionExpiredError)) fail(t(describePhoneFailure(failure)));
    } finally {
      resendInFlight.current = false;
      if (!signal.aborted) setResending(false);
      // Digits typed while the resend ran were held: a complete code is checked now, once. A code
      // put back after a failed resend waits for the user, as it did before the resend.
      if (!signal.aborted && !restored && codeNow.current.length === CODE_LENGTH) {
        void check(codeNow.current);
      }
    }
  };

  return {
    code,
    setCode,
    error,
    verifying,
    submit: () => check(code),
    resendIn: countdown.remaining,
    resending,
    resend,
  };
}
