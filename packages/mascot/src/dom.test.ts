import { describe, expect, it } from "vitest";

import { mountMascot } from "./dom.ts";
import type { MotionEnv, MotionState } from "./motion.ts";
import { RIGS } from "./rig.ts";

/** A container that keeps its markup, and a browser whose frames, tab and viewport the test drives. */
function page(start: { reduced?: boolean } = {}) {
  let html = "";
  const attributes = new Map<string, string>();
  const container = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
      attributes.clear();
    },
    querySelector: () => ({
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    }),
  };
  const frames = new Map<number, (time: number) => void>();
  let handles = 0;
  const intersect: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
  const visibility = new Set<() => void>();
  const state = { visibility: "visible" };
  const browser: MotionEnv & {
    requestAnimationFrame(callback: (time: number) => void): number;
    cancelAnimationFrame(handle: number): void;
  } = {
    matchMedia: () => ({
      matches: start.reduced ?? false,
      addEventListener() {},
      removeEventListener() {},
    }),
    document: {
      get visibilityState() {
        return state.visibility;
      },
      addEventListener: (_type, listener) => visibility.add(listener),
      removeEventListener: (_type, listener) => visibility.delete(listener),
    },
    IntersectionObserver: class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersect.push(callback);
      }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(callback) {
      handles += 1;
      frames.set(handles, callback);
      return handles;
    },
    cancelAnimationFrame(handle) {
      frames.delete(handle);
    },
  };
  return {
    container: container as unknown as Element,
    browser,
    html: () => html,
    attributes,
    frames,
    onScreen(value: boolean) {
      for (const callback of intersect) callback([{ isIntersecting: value }]);
    },
    hide() {
      state.visibility = "hidden";
      for (const listener of visibility) listener();
    },
    tick(time: number) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
    },
  };
}

describe("Jack without React", () => {
  it("draws the pose still, then runs only on screen in a shown tab", () => {
    const site = page();
    const states: MotionState[] = [];
    mountMascot(
      site.container,
      { pose: "wave", size: 128, title: "Jack", onMotion: (s) => states.push(s) },
      site.browser,
    );
    expect(site.html()).toMatch(
      /^<svg [^>]*width="128"[^>]*class="jack-dom\d+" data-motion="still"/,
    );
    expect(site.html()).toContain("<style>@media (prefers-reduced-motion:no-preference)");
    site.onScreen(true);
    expect(site.attributes.get("data-motion")).toBe("running");
    site.hide();
    expect(site.attributes.get("data-motion")).toBe("paused");
    expect(states).toEqual(["paused", "running", "paused"]);
  });

  it("changes pose at once, asking for no frame, while paused or under Reduce Motion", () => {
    for (const site of [page(), page({ reduced: true })]) {
      const mascot = mountMascot(site.container, { pose: "wave" }, site.browser);
      mascot.setPose("celebrate");
      expect(site.frames.size).toBe(0);
      expect(site.html()).toContain('data-part="expression-happy"');
    }
  });

  it("moves to a new pose frame by frame while running, then stops asking", () => {
    const site = page();
    const mascot = mountMascot(site.container, { pose: "wave" }, site.browser);
    site.onScreen(true);
    mascot.setPose("celebrate");
    expect(site.frames.size).toBe(1);
    for (const time of [0, 200, 400, 600]) site.tick(time);
    expect(site.frames.size).toBe(0);
    expect(site.html()).toContain('data-part="expression-happy"');
    expect(site.html()).not.toContain("glove-open");
    expect(RIGS.celebrate.arms.right.glove).toBe("fist");
  });

  it("stays a still picture with animate: false", () => {
    const site = page();
    mountMascot(site.container, { pose: "tools", animate: false }, site.browser);
    site.onScreen(true);
    expect(site.html()).not.toMatch(/<style|data-motion/);
    expect(site.attributes.size).toBe(0);
  });

  it("stops and empties its container when destroyed", () => {
    const site = page();
    const mascot = mountMascot(site.container, { pose: "peek" }, site.browser);
    site.onScreen(true);
    mascot.setPose("point");
    mascot.destroy();
    expect(site.frames.size).toBe(0);
    expect(site.html()).toBe("");
  });
});
