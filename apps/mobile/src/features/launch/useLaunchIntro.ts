import { useCallback, useEffect, useState } from "react";

import type { SessionStatus } from "@/api";
import { tokens } from "@/theme";

export type LaunchPhase = "running" | "exiting";

type Params = {
  status: SessionStatus;
  reduceMotion: boolean;
};

/**
 * When the launch intro hands off. It runs for at least `launchMinMs` (the swaps settle back on
 * the first word just before it) and until the session is no longer restoring, but
 * never past `launchMaxMs`: restore keeps running behind it and the gate shows what it must. A
 * tap ends it at once. Under Reduce Motion there is no minimum: it ends as soon as the gate has
 * a destination. These timers pace the whole intro, not its frames; the frames run on the UI
 * thread inside the rotator.
 */
export function useLaunchIntro({ status, reduceMotion }: Params): {
  phase: LaunchPhase;
  skip: () => void;
} {
  const { launchMinMs, launchMaxMs } = tokens.motion;
  const [minTimerElapsed, setMinTimerElapsed] = useState(false);
  const [maxElapsed, setMaxElapsed] = useState(false);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    if (reduceMotion) return; // no minimum: nothing to wait for
    const id = setTimeout(() => setMinTimerElapsed(true), launchMinMs);
    return () => clearTimeout(id);
  }, [launchMinMs, reduceMotion]);
  const minElapsed = reduceMotion || minTimerElapsed;

  useEffect(() => {
    const id = setTimeout(() => setMaxElapsed(true), launchMaxMs);
    return () => clearTimeout(id);
  }, [launchMaxMs]);

  const skip = useCallback(() => setSkipped(true), []);
  const resolved = status !== "restoring";
  const phase: LaunchPhase =
    skipped || maxElapsed || (minElapsed && resolved) ? "exiting" : "running";

  return { phase, skip };
}
