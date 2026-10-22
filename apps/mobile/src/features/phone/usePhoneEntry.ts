import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import { SessionExpiredError } from "@/api";

import { useSendCode } from "./api";
import { phoneConfig } from "./config";
import { describePhoneFailure } from "./errors";
import { startCodeStep } from "./phoneFlow";
import { editNationalDigits, formatNational, isValidNational, toE164 } from "./phoneNumber";

export type PhoneEntry = {
  /** What the field shows: the national number formatted as typed. */
  text: string;
  setText: (next: string) => void;
  error: string | null;
  sending: boolean;
  /** Checks the number on the device, then asks for a code; `onSent` runs once it is on its way. */
  submit: () => Promise<void>;
};

/**
 * The phone step: a US number formatted as it is typed, checked on the device, sent as E.164. The
 * number is never logged; it leaves this hook only in the request and in the flow store.
 */
export function usePhoneEntry(onSent: () => void): PhoneEntry {
  const { t } = useTranslation();
  const { countryCode } = phoneConfig;
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = useSendCode();
  // `isPending` is render state; the ref closes the gap between two taps in the same turn.
  const inFlight = useRef(false);

  const text = formatNational(digits);
  const setText = (next: string) => {
    setDigits(editNationalDigits(text, next, countryCode));
    setError(null);
  };

  const fail = (message: string) => {
    setError(message);
    AccessibilityInfo.announceForAccessibility(message);
  };

  const submit = async () => {
    if (inFlight.current) return;
    if (!isValidNational(digits)) {
      fail(t("phone.errors.invalidNumber"));
      return;
    }
    inFlight.current = true;
    try {
      await send.mutateAsync(toE164(countryCode, digits));
      startCodeStep(digits);
      onSent();
    } catch (failure) {
      // The session ended meanwhile: the gate is taking the user to welcome, nothing to say here.
      if (!(failure instanceof SessionExpiredError)) fail(t(describePhoneFailure(failure)));
    } finally {
      inFlight.current = false;
    }
  };

  return { text, setText, error, sending: send.isPending, submit };
}
