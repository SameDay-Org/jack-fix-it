import { describe, expect, it } from "vitest";

import { median, PROBE, probeFrames, type ProbeHost } from "./frame-probe";

/** A browser double: frames are delivered on `advance` while the page shows; timers run on time. */
function fakeBrowser() {
  let now = 0;
  let hidden = false;
  let nextId = 1;
  const frames = new Map<number, (time: number) => void>();
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners = new Set<() => void>();
  const host: ProbeHost = {
    requestFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    setTimer(run, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    isHidden: () => hidden,
    onVisibilityChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    host,
    /** Lets `ms` pass: due timers run, then a frame comes if the page shows (and `deliver`). */
    advance(ms: number, deliver = true) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
      if (hidden || !deliver) return;
      const due = [...frames.values()];
      frames.clear();
      due.forEach((callback) => callback(now));
    },
    setHidden(value: boolean) {
      hidden = value;
      listeners.forEach((listener) => listener());
    },
    listeners: () => listeners.size,
  };
}

/** Starts a probe and exposes its result once it settles. */
function start(browser: ReturnType<typeof fakeBrowser>, valid: () => boolean = () => true) {
  let draws = 0;
  const state: { result: boolean | undefined } = { result: undefined };
  void probeFrames(browser.host, () => (draws += 1), valid).then((result) => {
    state.result = result;
  });
  return { state, draws: () => draws };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the frame-time probe", () => {
  it("passes a device whose frames come at 60 per second, and lets go of its listener", async () => {
    const browser = fakeBrowser();
    const probe = start(browser);
    for (let i = 0; i <= PROBE.frames; i += 1) browser.advance(16);
    await settle();
    expect(probe.state.result).toBe(true);
    expect(probe.draws()).toBe(PROBE.frames + 1);
    expect(browser.listeners()).toBe(0);
  });

  it("fails a device whose frames take longer than the limit", async () => {
    const browser = fakeBrowser();
    const probe = start(browser);
    for (let i = 0; i <= PROBE.frames; i += 1) browser.advance(PROBE.maxMedianMs + 15);
    await settle();
    expect(probe.state.result).toBe(false);
  });

  it("fails when no frame comes in time while the page shows (a stalled GPU)", async () => {
    const browser = fakeBrowser();
    const probe = start(browser);
    browser.advance(PROBE.timeoutMs - 1, false);
    await settle();
    expect(probe.state.result).toBeUndefined();
    browser.advance(1, false);
    await settle();
    expect(probe.state.result).toBe(false);
  });

  it("waits while the tab is hidden: a background tab is not a slow device", async () => {
    const browser = fakeBrowser();
    browser.setHidden(true);
    const probe = start(browser);
    for (let i = 0; i < 20; i += 1) browser.advance(1000);
    await settle();
    expect(probe.state.result).toBeUndefined();
    expect(probe.draws()).toBe(0);

    browser.setHidden(false);
    for (let i = 0; i <= PROBE.frames; i += 1) browser.advance(16);
    await settle();
    expect(probe.state.result).toBe(true);
  });

  it("starts over when the tab is hidden half-way, and counts only time it shows", async () => {
    const browser = fakeBrowser();
    const probe = start(browser);
    for (let i = 0; i < 10; i += 1) browser.advance(16);
    browser.setHidden(true);
    browser.advance(PROBE.timeoutMs * 3);
    await settle();
    expect(probe.state.result).toBeUndefined();

    browser.setHidden(false);
    for (let i = 0; i <= PROBE.frames; i += 1) browser.advance(16);
    await settle();
    expect(probe.state.result).toBe(true);
  });

  it("leaves out pauses (a gap longer than pauseMs is not a slow frame)", async () => {
    const browser = fakeBrowser();
    const probe = start(browser);
    for (let i = 0; i <= PROBE.frames + 2; i += 1) {
      browser.advance(i === 5 || i === 12 ? 1200 : 16);
    }
    await settle();
    expect(probe.state.result).toBe(true);
  });

  it("fails as soon as the scene stops being valid (disposed, or the GPU context lost)", async () => {
    const browser = fakeBrowser();
    let valid = true;
    const probe = start(browser, () => valid);
    browser.advance(16);
    valid = false;
    browser.advance(16);
    await settle();
    expect(probe.state.result).toBe(false);
  });

  it("takes the median gap, so one slow frame (a shader compile) does not decide", () => {
    expect(median([16, 17, 300, 16, 18])).toBe(17);
    expect(median([10, 20, 30, 40])).toBe(25);
  });
});
