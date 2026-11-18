import { elbowOf } from "./parts/arms.ts";
import { interpolateRig, type PoseRig } from "./rig.ts";

/**
 * How Jack moves on the web (#404 PR 2), without a library:
 *
 * - idle loops (a blink, breathing, a small wave in the `wave` pose) are CSS animations on named
 *   groups (`idleCss`), inside `@media (prefers-reduced-motion: no-preference)`, and they only
 *   apply while the SVG says `data-motion="running"`;
 * - the SVG is rendered `still` (a static pose, no JavaScript needed); the page's script turns
 *   it `running` only when motion is allowed, the tab is shown and Jack is on screen
 *   (`motionState`, `watchMotion`), and back to `paused` when not;
 * - a pose change moves the rig's numbers frame by frame (`transition`) while running, and
 *   jumps to the new pose otherwise: no timer, no frame is ever asked for when it cannot run.
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

/** Seconds per loop. */
export const IDLE_SECONDS = { blink: 4.8, breathe: 4, wave: 1.6 } as const;

/** The pose change's length, in milliseconds. */
export const TRANSITION_MS = 480;

/** A class name for one mascot's CSS (React ids hold characters CSS does not take). */
export function motionScope(id: string): string {
  return `jack-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** The idle loops for one mascot, scoped to its class: nothing here applies unless running. */
export function idleCss(scope: string, rig: PoseRig): string {
  const run = `.${scope}[data-motion=running]`;
  const rules = [
    `${run} [data-part=upper]{transform-box:view-box;transform-origin:100px 150px;animation:${scope}-breathe ${IDLE_SECONDS.breathe}s ease-in-out infinite}`,
    `@keyframes ${scope}-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.4px)}}`,
  ];
  // Laughing eyes are already closed: no blink then.
  if (rig.expression !== "happy") {
    rules.push(
      `${run} [data-part=eyes]{transform-box:fill-box;transform-origin:center;animation:${scope}-blink ${IDLE_SECONDS.blink}s ease-in-out infinite}`,
      `@keyframes ${scope}-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.12)}}`,
    );
  }
  const waving = rig.arms.right.glove === "open" && rig.arms.right.upper > 90 && !rig.lean.x;
  if (waving) {
    const elbow = elbowOf("right", rig.arms.right);
    rules.push(
      `${run} [data-part=forearm-right]{transform-box:view-box;transform-origin:${elbow.x}px ${elbow.y}px;animation:${scope}-wave ${IDLE_SECONDS.wave}s ease-in-out infinite}`,
      `@keyframes ${scope}-wave{0%,100%{transform:rotate(0)}50%{transform:rotate(-14deg)}}`,
    );
  }
  return `@media (prefers-reduced-motion:no-preference){${rules.join("")}}`;
}

export type FrameScheduler = {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
};

/**
 * Moves from one rig to another over `TRANSITION_MS`, calling `onFrame` with each in-between
 * rig and last with `to`. When it cannot run (reduced motion, a hidden tab, off screen, or not
 * animated), it calls `onFrame(to)` at once and asks for no frame at all; if it stops being able
 * to run on the way, it jumps to `to`. Returns a cancel.
 */
export function transition(options: {
  from: PoseRig;
  to: PoseRig;
  canRun: () => boolean;
  frames: FrameScheduler;
  onFrame: (rig: PoseRig) => void;
  duration?: number;
}): () => void {
  const { from, to, canRun, frames, onFrame } = options;
  const duration = options.duration ?? TRANSITION_MS;
  if (!canRun()) {
    onFrame(to);
    return () => {};
  }
  let handle = 0;
  let start: number | null = null;
  let done = false;
  const step = (time: number) => {
    if (done) return;
    if (!canRun()) {
      done = true;
      onFrame(to);
      return;
    }
    start ??= time;
    const t = Math.min(1, (time - start) / duration);
    onFrame(t >= 1 ? to : interpolateRig(from, to, t));
    if (t >= 1) {
      done = true;
      return;
    }
    handle = frames.request(step);
  };
  handle = frames.request(step);
  return () => {
    done = true;
    frames.cancel(handle);
  };
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
