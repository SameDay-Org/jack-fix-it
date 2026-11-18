import {
  idleCss,
  motionScope,
  transition,
  watchMotion,
  type MotionEnv,
  type MotionState,
} from "./motion.ts";
import type { MascotPose } from "./poses.ts";
import { renderSvg } from "./render.ts";
import { RIGS, rigNode, type PoseRig } from "./rig.ts";

/**
 * Jack without React, in a container element: the same drawing, idle loops and pose changes as
 * `<Mascot>` (react.ts), for the local gallery and for pages without React.
 */
export type MountOptions = {
  pose: MascotPose;
  size?: number;
  title?: string;
  animate?: boolean;
  /** The gallery's Reduce Motion toggle: true acts as if the reader asked for reduced motion. */
  forceReduced?: () => boolean;
  /** Told the motion state whenever it changes. */
  onMotion?: (state: MotionState) => void;
};

export type MountedMascot = {
  setPose(pose: MascotPose): void;
  /** Reads the motion gate again (after `forceReduced` changed). */
  refresh(): void;
  motion(): MotionState;
  destroy(): void;
};

type Browser = MotionEnv & {
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
};

let mounted = 0;

export function mountMascot(
  container: Element,
  options: MountOptions,
  browser: Browser = window,
): MountedMascot {
  const animate = options.animate ?? true;
  mounted += 1;
  const scope = motionScope(`dom${mounted}`);
  let rig: PoseRig = RIGS[options.pose];
  let motion: MotionState = "still";
  let stopWatching = () => {};
  let cancelMove = () => {};

  const draw = () => {
    container.innerHTML = renderSvg(rigNode(rig), {
      size: options.size,
      title: options.title,
      titleId: `${scope}-title`,
      ...(animate ? { motion: { scope, state: motion, css: idleCss(scope, rig) } } : {}),
    });
  };
  const setMotion = (state: MotionState) => {
    motion = state;
    // Only the attribute changes: the loops carry on from where they are. A still picture
    // (animate: false) has no motion state at all.
    if (animate) container.querySelector("svg")?.setAttribute("data-motion", state);
    options.onMotion?.(state);
  };
  const watch = () => {
    stopWatching();
    stopWatching = watchMotion(
      container,
      { animate, forceReduced: options.forceReduced },
      setMotion,
      browser,
    );
  };

  draw();
  watch();
  return {
    setPose(pose) {
      cancelMove();
      cancelMove = transition({
        from: rig,
        to: RIGS[pose],
        canRun: () => motion === "running",
        frames: {
          request: (callback) => browser.requestAnimationFrame(callback),
          cancel: (handle) => browser.cancelAnimationFrame(handle),
        },
        onFrame: (next) => {
          rig = next;
          draw();
        },
      });
    },
    refresh: watch,
    motion: () => motion,
    destroy() {
      cancelMove();
      stopWatching();
      container.innerHTML = "";
    },
  };
}
