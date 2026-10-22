import { useCallback, useEffect, useState } from "react";

import type { SessionStatus } from "@/api";
import { tokens } from "@/theme";

export type LaunchPhase = "running" | "exiting";

type Params = {
  status: SessionStatus;
  reduceMotion: boolean;
  /** The rotator's run has settled on its last word (the sentence reads "fix" again). */
  runDone: boolean;
};

/**
 * When the launch intro hands off. It runs for at least `launchMinMs`, until the swaps have
 * settled back on the first word (the run starts on the UI thread once the words are measured,
 * so the timer alone could cut the last swap on a busy device) and until the session is no
 * longer restoring, but never past `launchMaxMs`: restore keeps running behind it and the gate
 * shows what it must. A tap ends it at once. Under Reduce Motion there is no minimum and no wait
 * for the run: it ends as soon as the gate has a destination. These timers pace the whole intro,
 * not its frames; the frames run on the UI thread inside the rotator.
 */
export function useLaunchIntro({ status, reduceMotion, runDone }: Params): {
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
  const settled = reduceMotion || runDone;
  const phase: LaunchPhase =
    skipped || maxElapsed || (minElapsed && settled && resolved) ? "exiting" : "running";

  return { phase, skip };
}
