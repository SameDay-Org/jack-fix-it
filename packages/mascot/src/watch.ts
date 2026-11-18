/**
 * When a mascot may move (#404): the reduced-motion setting, the tab's visibility and whether
 * Jack is on screen. It imports nothing, so it is the only part of the package a page needs in
 * its JavaScript to animate a mascot drawn on the server (`react-motion.ts`).
 */

export type MotionState = "still" | "paused" | "running";

export type MotionInputs = {
  /** The `animate` prop. */
  animate: boolean;
  /** The reader asked for reduced motion (or the gallery's toggle does). */
  reducedMotion: boolean;
  /** The tab is shown. */
  pageVisible: boolean;
  /** Some of Jack is in the viewport. */
  onScreen: boolean;
};

export function motionState(inputs: MotionInputs): MotionState {
  if (!inputs.animate || inputs.reducedMotion) return "still";
  return inputs.pageVisible && inputs.onScreen ? "running" : "paused";
}

/** What `watchMotion` needs from the browser (a window, or a test's fakes). */
export type MotionEnv = {
  matchMedia(query: string): {
    matches: boolean;
    addEventListener(type: "change", listener: () => void): void;
    removeEventListener(type: "change", listener: () => void): void;
  };
  document: {
    visibilityState: string;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
  };
  IntersectionObserver?: new (callback: (entries: { isIntersecting: boolean }[]) => void) => {
    observe(target: Element): void;
    disconnect(): void;
  };
};

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Tells `onChange` whether this mascot may move now, and again whenever that changes: the
 * reduced-motion setting, the tab's visibility and whether it is in the viewport. Without
 * `animate`, it says `still` once and watches nothing. Returns a stop.
 */
export function watchMotion(
  target: Element,
  options: { animate: boolean; forceReduced?: () => boolean },
  onChange: (state: MotionState) => void,
  env: MotionEnv,
): () => void {
  if (!options.animate) {
    onChange("still");
    return () => {};
  }
  const reduce = env.matchMedia(REDUCED_MOTION_QUERY);
  let onScreen = false;
  let last: MotionState | null = null;
  const update = () => {
    const state = motionState({
      animate: true,
      reducedMotion: reduce.matches || (options.forceReduced?.() ?? false),
      pageVisible: env.document.visibilityState === "visible",
      onScreen,
    });
    if (state !== last) {
      last = state;
      onChange(state);
    }
  };
  const observer = env.IntersectionObserver
    ? new env.IntersectionObserver((entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        update();
      })
    : null;
  // Without IntersectionObserver there is no way to know: it never runs off screen, so it
  // never runs.
  observer?.observe(target);
  reduce.addEventListener("change", update);
  env.document.addEventListener("visibilitychange", update);
  update();
  return () => {
    observer?.disconnect();
    reduce.removeEventListener("change", update);
    env.document.removeEventListener("visibilitychange", update);
  };
}
