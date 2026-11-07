import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { sessionGeneration } from "@/api";
import { announce } from "@/components/ui/focus";

import { checkIn, useSingleFlight } from "./api";
import { ARRIVAL_CODE_LENGTH, proJobsConfig } from "./config";
import {
  currentPosition,
  LocationUnavailableError,
  useLocationAccess,
  type CheckInPosition,
} from "./location";
import { reportStepFailure } from "./ProJobScreen";

/**
 * Where the check-in sheet is:
 * - `entry`: typing the code, with the last attempt's message under it when there is one;
 * - `ask`: the app explains why it needs the location, before the system asks;
 * - `locating`, `sending`: the position, then the check-in, under way;
 * - `blocked`: the permission is refused for good (Open Settings);
 * - `off`: the phone's location is switched off;
 * - `timeout`: no position in time, or the system could not give one (a calm retry);
 * - `locked`: too many wrong codes; nothing to retry.
 */
export type CheckInPhase =
  "entry" | "ask" | "locating" | "sending" | "blocked" | "off" | "timeout" | "locked";

/**
 * The check-in of one job: the 4-digit code the customer reads out, and the phone's position at
 * the moment it is sent. The position is asked for only here, after the app said why; the code
 * leaves state as the request goes out (a wrong one is typed again), and neither is logged,
 * cached or kept. Every call is pinned to the session the tap was made in, and a sheet closed
 * while the position was found sends nothing.
 */
export function useCheckIn(jobId: string, customer: string, leave: () => void) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { access, ask, openSettings } = useLocationAccess();
  const { run, mounted } = useSingleFlight();
  const [code, setCode] = useState("");
  const [shownPhase, setPhase] = useState<CheckInPhase>("entry");
  const [message, setMessage] = useState<string | null>(null);
  // Back from Settings with the location allowed: the pro checks in from where they were.
  const phase = shownPhase === "blocked" && access === "granted" ? "entry" : shownPhase;

  /** Back to the code with what went wrong under it, said aloud on both platforms. */
  const fail = (text: string) => {
    setPhase("entry");
    setMessage(text);
    announce(text);
  };

  const send = (generation: number) =>
    run(async () => {
      setMessage(null);
      setPhase("locating");
      let position: CheckInPosition;
      try {
        position = await currentPosition(proJobsConfig.locationTimeoutMs);
      } catch (error) {
        if (!mounted.current) return;
        const reason = error instanceof LocationUnavailableError ? error.reason : "failed";
        setPhase(reason === "off" ? "off" : reason === "denied" ? "blocked" : "timeout");
        return;
      }
      // Closed while the position was found: nothing is sent.
      if (!mounted.current) return;
      const arrivalCode = code;
      setCode("");
      setPhase("sending");
      const outcome = await checkIn(client, jobId, arrivalCode, position, generation);
      if (outcome.kind === "checkedIn") {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
        if (mounted.current) leave();
        return;
      }
      if (!mounted.current) return;
      // The sheet's notice says it (a notice announces itself).
      if (outcome.kind === "locked") {
        setPhase("locked");
        return;
      }
      if (outcome.kind === "wrongCode") {
        fail(
          outcome.triesLeft === null
            ? t("proJobs.checkIn.wrongUnknown", { name: customer })
            : t("proJobs.checkIn.wrong", { count: outcome.triesLeft }),
        );
        return;
      }
      const { failure } = outcome;
      if (failure === "signedOut") return;
      if (failure === "offline" || failure === "failed") {
        fail(t(`proJobs.failure.${failure}`));
        return;
      }
      reportStepFailure(t, client, jobId, generation, failure);
      leave();
    });

  /** "Check in": with the location allowed it goes; otherwise the app explains first. */
  const submit = () => {
    if (code.length !== ARRIVAL_CODE_LENGTH) return;
    const generation = sessionGeneration();
    if (access === "granted") void send(generation);
    else if (access === "blocked") setPhase("blocked");
    else setPhase("ask");
  };

  /** "Continue" after the explanation: the system's prompt, then the check-in if allowed. */
  const allow = () => {
    const generation = sessionGeneration();
    void ask().then((granted) => {
      if (!mounted.current) return;
      if (granted) void send(generation);
      else setPhase("blocked");
    });
  };

  /** Back to the code, as it was typed (the explanation or a location problem dismissed). */
  const back = () => setPhase("entry");

  /** Another try at the position, with the code still typed. */
  const retry = () => void send(sessionGeneration());

  const changeCode = (digits: string) => {
    setCode(digits);
    if (message) setMessage(null);
  };

  return {
    code,
    changeCode,
    phase,
    message,
    complete: code.length === ARRIVAL_CODE_LENGTH,
    submit,
    allow,
    back,
    retry,
    openSettings,
  };
}
