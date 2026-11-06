import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import {
  ApiError,
  isCurrentGeneration,
  SessionExpiredError,
  sessionGeneration,
  setSessionUser,
} from "@/api";
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
  /**
   * A new code was just sent from the phone step on the same screen: the field starts empty and
   * "Resend code" waits its full time again.
   */
  startOver: () => void;
};

export type CodeEntryOptions = {
  /**
   * Whether a code is already on its way when the hook mounts, so the resend wait starts at once
   * (the code screen). False when the code step shares a screen with the phone step: nothing ticks
   * until `startOver`.
   */
  codeSent?: boolean;
  /**
   * The session generation the code was sent in (`usePhoneEntry`'s `onSent`): the check and every
   * resend are pinned to it, so after another sign-in nothing is sent with that account's token.
   * Without it each operation is pinned to the session it starts in, and the check a resend runs
   * when it settles to the resend's.
   */
  generation?: number;
};

const INVALID_CODE = "invalid_code";

/**
 * The code step for the number a code was sent to (national digits): the code, sent as soon as it
 * is complete, a resend that waits `phoneConfig.resendSeconds` between codes, and errors mapped to
 * catalog text and announced. A wrong code is cleared so the next one can be typed straight away.
 * Neither the number nor the code is ever logged. `onVerified` runs once the session holds the
 * verified user; what the person is told is the caller's.
 *
 * One operation at a time: while a code is checked, edits are ignored and resend waits; while a
 * resend runs, digits can be typed but are held, and once it settles a complete code is checked,
 * once. Leaving the screen cancels whatever is in flight, and a late answer neither navigates,
 * toasts, announces nor writes the session. The same holds once the session an operation belongs
 * to is gone (a sign-out or another sign-in, #295 Vault B1): nothing more is sent, shown or
 * called back, and a resend that ends that way never checks the digits held during it.
 */
export function useCodeEntry(
  digits: string,
  onVerified: () => void,
  { codeSent = true, generation }: CodeEntryOptions = {},
): CodeEntry {
  const { t } = useTranslation();
  const { countryCode, resendSeconds } = phoneConfig;
  const phone = toE164(countryCode, digits);
  const [code, setCodeState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const countdown = useCountdown(resendSeconds, codeSent);
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

  // The session an operation belongs to: the code's, else the one current as the operation starts.
  const pinnedNow = () => generation ?? sessionGeneration();

  const check = async (candidate: string, pinned = pinnedNow()) => {
    if (inFlight.current || resendInFlight.current || candidate.length !== CODE_LENGTH) return;
    // The session the code belongs to is gone: the check is not this session's to run.
    if (!isCurrentGeneration(pinned)) return;
    const signal = unmountSignal();
    inFlight.current = true;
    setVerifying(true);
    try {
      const user = await verifyCode(phone, candidate, signal, pinned);
      if (signal.aborted) return; // the user left: this flow is over
      if (!isCurrentGeneration(pinned)) return; // a verified user for a session that is gone
      setSessionUser(user);
      onVerified();
    } catch (failure) {
      if (signal.aborted) return;
      // The session ended meanwhile: the gate is taking the user to welcome, nothing to say here.
      if (failure instanceof SessionExpiredError || !isCurrentGeneration(pinned)) return;
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
    const pinned = pinnedNow();
    if (!isCurrentGeneration(pinned)) return;
    const signal = unmountSignal();
    resendInFlight.current = true;
    setResending(true);
    // A new code is on its way: the field starts empty for it.
    const before = codeNow.current;
    keepCode("");
    setError(null);
    let restored = false;
    // The session ended while the code went out: the chain stops here, with nothing checked.
    let superseded = false;
    try {
      await sendCode(phone, signal, pinned);
      if (signal.aborted) return;
      if (!isCurrentGeneration(pinned)) {
        superseded = true;
        return;
      }
      countdown.restart();
      showToast({ message: t("phone.codeResent"), tone: "neutral" });
    } catch (failure) {
      if (signal.aborted) return;
      // The session ended meanwhile: the gate is taking the user away, nothing to say or check.
      if (failure instanceof SessionExpiredError || !isCurrentGeneration(pinned)) {
        superseded = true;
        return;
      }
      // No new code is coming: the one typed before is still good, unless something was typed since.
      if (codeNow.current === "" && before !== "") {
        keepCode(before);
        restored = true;
      }
      fail(t(describePhoneFailure(failure)));
    } finally {
      resendInFlight.current = false;
      if (!signal.aborted) setResending(false);
      // Digits typed while the resend ran were held: a complete code is checked now, once, in the
      // resend's session. A code put back after a failed resend waits for the user, as it did
      // before the resend; after a session change nothing is checked.
      const held = codeNow.current;
      if (!signal.aborted && !restored && !superseded && held.length === CODE_LENGTH) {
        void check(held, pinned);
      }
    }
  };

  const startOver = () => {
    keepCode("");
    setError(null);
    countdown.restart();
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
    startOver,
  };
}
