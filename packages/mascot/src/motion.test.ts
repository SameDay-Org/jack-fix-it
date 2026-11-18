import { describe, expect, it } from "vitest";

import {
  idleCss,
  motionScope,
  motionState,
  transition,
  watchMotion,
  type MotionEnv,
  type MotionState,
} from "./motion.ts";
import { MASCOT_POSES } from "./poses.ts";
import { RIGS, type PoseRig } from "./rig.ts";

describe("whether Jack may move", () => {
  it.each([
    [{ animate: false, reducedMotion: false, pageVisible: true, onScreen: true }, "still"],
    [{ animate: true, reducedMotion: true, pageVisible: true, onScreen: true }, "still"],
    [{ animate: true, reducedMotion: false, pageVisible: false, onScreen: true }, "paused"],
    [{ animate: true, reducedMotion: false, pageVisible: true, onScreen: false }, "paused"],
    [{ animate: true, reducedMotion: false, pageVisible: true, onScreen: true }, "running"],
  ] as const)("%o is %s", (inputs, state) => {
    expect(motionState(inputs)).toBe(state);
  });
});

describe("the idle loops", () => {
  const scope = motionScope(":r1:");

  it("give each mascot a class name CSS takes", () => {
    expect(scope).toBe("jack-r1");
    expect(motionScope("«R1»")).toBe("jack-R1");
  });

  it.each(MASCOT_POSES)(
    "of %s are all inside the no-preference query, and only while running",
    (pose) => {
      const css = idleCss(scope, RIGS[pose]);
      expect(css.startsWith("@media (prefers-reduced-motion:no-preference){")).toBe(true);
      expect(css.endsWith("}")).toBe(true);
      // Every rule that animates waits for data-motion=running on this mascot's own root.
      const animated = [...css.matchAll(/([^{}]+)\{[^{}]*animation:/g)].map((match) => match[1]!);
      expect(animated.length).toBeGreaterThan(0);
      for (const selector of animated)
        expect(selector).toContain(`.${scope}[data-motion=running] `);
      // Keyframes are scoped too, and nothing reaches outside the drawing.
      for (const [, name] of css.matchAll(/@keyframes ([a-z0-9-]+)/gi)) {
        expect(name!.startsWith(`${scope}-`)).toBe(true);
      }
      expect(css).not.toMatch(/url\(|@import|["'<>&]/);
    },
  );

  it("breathe and blink in every pose, wave only in the wave pose, and do not blink laughing eyes", () => {
    expect(idleCss(scope, RIGS.wave)).toMatch(
      /\[data-part=forearm-right\]\{transform-box:view-box;transform-origin:[\d.]+px [\d.]+px;animation:jack-r1-wave/,
    );
    for (const pose of MASCOT_POSES.filter((name) => name !== "wave")) {
      expect(idleCss(scope, RIGS[pose])).not.toContain("-wave");
      expect(idleCss(scope, RIGS[pose])).toContain("[data-part=upper]");
    }
    expect(idleCss(scope, RIGS.celebrate)).not.toContain("[data-part=eyes]");
    expect(idleCss(scope, RIGS.tools)).toContain("[data-part=eyes]");
  });
});

/** A frame clock that runs only when the test says so. */
function clock() {
  const pending = new Map<number, (time: number) => void>();
  let next = 1;
  let requested = 0;
  return {
    frames: {
      request(callback: (time: number) => void) {
        requested += 1;
        pending.set(next, callback);
        return next++;
      },
      cancel(handle: number) {
        pending.delete(handle);
      },
    },
    tick(time: number) {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(time);
    },
    requested: () => requested,
    pending: () => pending.size,
  };
}

describe("a pose change on screen", () => {
  it("asks for no frame and shows the new pose at once when it may not run (Reduce Motion, hidden, off screen)", () => {
    const frames = clock();
    const shown: PoseRig[] = [];
    transition({
      from: RIGS.wave,
      to: RIGS.celebrate,
      canRun: () => false,
      frames: frames.frames,
      onFrame: (rig) => shown.push(rig),
    });
    expect(frames.requested()).toBe(0);
    expect(shown).toEqual([RIGS.celebrate]);
  });

  it("moves frame by frame while it may run, and ends on the new pose", () => {
    const frames = clock();
    const shown: PoseRig[] = [];
    transition({
      from: RIGS.wave,
      to: RIGS.celebrate,
      canRun: () => true,
      frames: frames.frames,
      onFrame: (rig) => shown.push(rig),
      duration: 400,
    });
    for (const time of [1000, 1100, 1200, 1300, 1400, 1500]) frames.tick(time);
    expect(shown.length).toBe(5);
    expect(shown.at(-1)).toEqual(RIGS.celebrate);
    expect(shown[1]!.arms.left.upper).toBeGreaterThan(RIGS.wave.arms.left.upper);
    expect(shown[1]!.arms.left.upper).toBeLessThan(RIGS.celebrate.arms.left.upper);
    expect(frames.pending()).toBe(0);
  });

  it("jumps to the new pose and stops asking for frames when it stops being allowed on the way", () => {
    const frames = clock();
    const shown: PoseRig[] = [];
    let allowed = true;
    transition({
      from: RIGS.wave,
      to: RIGS.tools,
      canRun: () => allowed,
      frames: frames.frames,
      onFrame: (rig) => shown.push(rig),
      duration: 400,
    });
    frames.tick(0);
    frames.tick(100);
    allowed = false; // the tab was hidden
    frames.tick(200);
    expect(shown.at(-1)).toEqual(RIGS.tools);
    const asked = frames.requested();
    frames.tick(300);
    expect(frames.requested()).toBe(asked);
    expect(frames.pending()).toBe(0);
  });

  it("stops when cancelled", () => {
    const frames = clock();
    const cancel = transition({
      from: RIGS.wave,
      to: RIGS.peek,
      canRun: () => true,
      frames: frames.frames,
      onFrame: () => {},
    });
    cancel();
    expect(frames.pending()).toBe(0);
  });
});

/** A browser for watchMotion: Reduce Motion, the tab's visibility, the viewport. */
function browser(start: { reduced?: boolean; visible?: boolean; observer?: boolean } = {}) {
  const listeners = { reduce: new Set<() => void>(), visibility: new Set<() => void>() };
  const observers: {
    callback: (entries: { isIntersecting: boolean }[]) => void;
    observed: unknown[];
    disconnected: boolean;
  }[] = [];
  const state = {
    reduced: start.reduced ?? false,
    visibility: start.visible === false ? "hidden" : "visible",
  };
  const env: MotionEnv = {
    matchMedia: () => ({
      get matches() {
        return state.reduced;
      },
      addEventListener: (_type, listener) => listeners.reduce.add(listener),
      removeEventListener: (_type, listener) => listeners.reduce.delete(listener),
    }),
    document: {
      get visibilityState() {
        return state.visibility;
      },
      addEventListener: (_type, listener) => listeners.visibility.add(listener),
      removeEventListener: (_type, listener) => listeners.visibility.delete(listener),
    },
    IntersectionObserver:
      start.observer === false
        ? undefined
        : class {
            entry: (typeof observers)[number];
            constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
              this.entry = { callback, observed: [], disconnected: false };
              observers.push(this.entry);
            }
            observe(target: unknown) {
              this.entry.observed.push(target);
            }
            disconnect() {
              this.entry.disconnected = true;
            }
          },
  };
  return {
    env,
    observers,
    listeners,
    setReduced(value: boolean) {
      state.reduced = value;
      for (const listener of listeners.reduce) listener();
    },
    setVisible(value: boolean) {
      state.visibility = value ? "visible" : "hidden";
      for (const listener of listeners.visibility) listener();
    },
    setOnScreen(value: boolean) {
      for (const observer of observers) observer.callback([{ isIntersecting: value }]);
    },
  };
}

const target = {} as Element;

describe("watching whether it may move", () => {
  it("stays still and watches nothing when not animated", () => {
    const page = browser();
    const states: MotionState[] = [];
    watchMotion(target, { animate: false }, (state) => states.push(state), page.env);
    expect(states).toEqual(["still"]);
    expect(page.observers).toHaveLength(0);
    expect(page.listeners.reduce.size + page.listeners.visibility.size).toBe(0);
  });

  it("stays still under Reduce Motion, whatever the tab and the viewport say", () => {
    const page = browser({ reduced: true });
    const states: MotionState[] = [];
    watchMotion(target, { animate: true }, (state) => states.push(state), page.env);
    page.setOnScreen(true);
    page.setVisible(true);
    expect(states).toEqual(["still"]);
  });

  it("is paused until on screen, runs there, and pauses when the tab is hidden or it scrolls away", () => {
    const page = browser();
    const states: MotionState[] = [];
    watchMotion(target, { animate: true }, (state) => states.push(state), page.env);
    expect(states).toEqual(["paused"]);
    page.setOnScreen(true);
    page.setVisible(false);
    page.setVisible(true);
    page.setOnScreen(false);
    expect(states).toEqual(["paused", "running", "paused", "running", "paused"]);
  });

  it("follows the Reduce Motion setting and the gallery's toggle", () => {
    const page = browser();
    let forced = false;
    const states: MotionState[] = [];
    watchMotion(
      target,
      { animate: true, forceReduced: () => forced },
      (state) => states.push(state),
      page.env,
    );
    page.setOnScreen(true);
    page.setReduced(true);
    page.setReduced(false);
    forced = true;
    page.setVisible(true);
    expect(states).toEqual(["paused", "running", "still", "running", "still"]);
  });

  it("never runs without IntersectionObserver: it cannot know it is on screen", () => {
    const page = browser({ observer: false });
    const states: MotionState[] = [];
    watchMotion(target, { animate: true }, (state) => states.push(state), page.env);
    page.setVisible(true);
    expect(states).toEqual(["paused"]);
  });

  it("lets go of everything it watched when stopped", () => {
    const page = browser();
    const stop = watchMotion(target, { animate: true }, () => {}, page.env);
    expect(page.observers[0]!.observed).toEqual([target]);
    stop();
    expect(page.observers[0]!.disconnected).toBe(true);
    expect(page.listeners.reduce.size + page.listeners.visibility.size).toBe(0);
  });
});
