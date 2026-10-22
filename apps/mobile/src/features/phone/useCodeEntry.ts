import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import { ApiError, SessionExpiredError } from "@/api";
import { showToast } from "@/components/ui";

import { useSendCode, useVerifyCode } from "./api";
import { CODE_LENGTH, phoneConfig } from "./config";
import { describePhoneFailure } from "./errors";
import { toE164 } from "./phoneNumber";
import { useCountdown } from "./useCountdown";

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
 */
export function useCodeEntry(digits: string, onVerified: () => void): CodeEntry {
  const { t } = useTranslation();
  const { countryCode, resendSeconds } = phoneConfig;
  const phone = toE164(countryCode, digits);
  const [code, setCodeState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const verify = useVerifyCode();
  const send = useSendCode();
  const countdown = useCountdown(resendSeconds);
  const inFlight = useRef(false);
  const resendInFlight = useRef(false);

  const fail = (message: string) => {
    setError(message);
    AccessibilityInfo.announceForAccessibility(message);
  };

  const check = async (candidate: string) => {
    if (inFlight.current || candidate.length !== CODE_LENGTH) return;
    inFlight.current = true;
    try {
      await verify.mutateAsync({ phone, code: candidate });
      showToast({ message: t("phone.verified"), tone: "success" });
      onVerified();
    } catch (failure) {
      // The session ended meanwhile: the gate is taking the user to welcome, nothing to say here.
      if (failure instanceof SessionExpiredError) return;
      if (failure instanceof ApiError && failure.code === INVALID_CODE) setCodeState("");
      fail(t(describePhoneFailure(failure)));
    } finally {
      inFlight.current = false;
    }
  };

  const setCode = (next: string) => {
    if (inFlight.current) return; // the code being checked stays as it is
    setCodeState(next);
    setError(null);
    if (next.length === CODE_LENGTH) void check(next);
  };

  const resend = async () => {
    if (countdown.remaining > 0 || resendInFlight.current) return;
    resendInFlight.current = true;
    try {
      await send.mutateAsync(phone);
      countdown.restart();
      setCodeState("");
      setError(null);
      showToast({ message: t("phone.codeResent"), tone: "neutral" });
    } catch (failure) {
      if (!(failure instanceof SessionExpiredError)) fail(t(describePhoneFailure(failure)));
    } finally {
      resendInFlight.current = false;
    }
  };

  return {
    code,
    setCode,
    error,
    verifying: verify.isPending,
    submit: () => check(code),
    resendIn: countdown.remaining,
    resending: send.isPending,
    resend,
  };
}
