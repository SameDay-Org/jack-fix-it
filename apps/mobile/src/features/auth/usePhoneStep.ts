import { useCallback, useEffect, useState } from "react";

import { CODE_LENGTH, phoneConfig } from "@/features/phone/config";
import { forgetPendingNumber, usePendingNumber } from "@/features/phone/phoneFlow";
import { useCodeEntry, type CodeEntry } from "@/features/phone/useCodeEntry";
import { usePhoneEntry, type PhoneEntry } from "@/features/phone/usePhoneEntry";

/** The phone step's two panes: the number, then the code sent to it. */
export type PhonePane = "number" | "code";

export type PhoneStep = {
  pane: PhonePane;
  number: PhoneEntry;
  code: CodeEntry;
  /** The national digits the code went to, for "We sent it to …"; null before a code is sent. */
  sentTo: string | null;
  /** Back to the number, kept as typed; the code sent is forgotten with its digits. */
  changeNumber: () => void;
  /** What the card shows: the number as typed, behind the calling code; empty until typed. */
  cardPhone: string;
  /** The screen's one action for the pane on screen. */
  action: { run: () => Promise<void>; busy: boolean; disabled: boolean };
};

/**
 * The sign-up's phone step (#295), inline: the phone feature's number and code hooks on one
 * screen, with their rules, errors, resend wait and secret handling unchanged. The number goes out
 * only in the requests and the flow store, and both it and the code end with the flow (the hooks'
 * requests are cancelled when it unmounts). `onCodeSent` runs as the code pane is due; a verified
 * number is in the session when `onVerified` runs.
 */
export function usePhoneStep(onCodeSent: () => void, onVerified: () => void): PhoneStep {
  const [pane, setPane] = useState<PhonePane>("number");
  const sentTo = usePendingNumber();
  // The session the code went out in: its check and resends are pinned to it (#292 Vault B1), so
  // a code sent for one account is never checked with another's token.
  const [sentIn, setSentIn] = useState<number | undefined>(undefined);
  // Nothing ticks until a code is sent: the resend wait starts with it.
  const code = useCodeEntry(sentTo ?? "", onVerified, { codeSent: false, generation: sentIn });
  const { startOver } = code;
  const number = usePhoneEntry(
    useCallback(
      (generation: number) => {
        setSentIn(generation);
        startOver();
        setPane("code");
        onCodeSent();
      },
      [onCodeSent, startOver],
    ),
  );

  // The digits a code went to end with the flow, as they do with the code screen.
  useEffect(() => forgetPendingNumber, []);

  const changeNumber = () => {
    forgetPendingNumber();
    setPane("number");
  };

  const action =
    pane === "number"
      ? { run: number.submit, busy: number.sending, disabled: false }
      : {
          run: code.submit,
          busy: code.verifying,
          disabled: code.code.length < CODE_LENGTH || code.resending,
        };

  return {
    pane,
    number,
    code,
    sentTo: pane === "code" ? sentTo : null,
    changeNumber,
    cardPhone: number.text ? `${phoneConfig.countryCode} ${number.text}` : "",
    action,
  };
}
