import { describe, expect, it } from "vitest";

import { loadTriggers } from "./load-triggers";

function setup(start: { canLoad: boolean }) {
  const calls = { download: 0, build: 0 };
  const state = { canLoad: start.canLoad };
  const triggers = loadTriggers({
    canLoad: () => state.canLoad,
    download: () => (calls.download += 1),
    build: () => (calls.build += 1),
  });
  return { calls, state, triggers };
}

describe("when the 3D phone loads", () => {
  it("downloads its chunk once the page is idle, and builds nothing without intent", () => {
    const { calls, triggers } = setup({ canLoad: true });
    triggers.idle();
    expect(calls).toEqual({ download: 1, build: 0 });
  });

  it("builds on the reader's first intent, once, however many intents follow", () => {
    const { calls, triggers } = setup({ canLoad: true });
    triggers.idle();
    triggers.intent();
    triggers.intent();
    triggers.changed();
    expect(calls.build).toBe(1);
  });

  it("downloads and builds on an intent that comes before the idle moment", () => {
    const { calls, triggers } = setup({ canLoad: true });
    triggers.intent();
    expect(calls).toEqual({ download: 1, build: 1 });
    triggers.idle();
    expect(calls.build).toBe(1);
  });

  it("does nothing while it cannot load (a hidden tab, a hero not pinned), then catches up", () => {
    const { calls, state, triggers } = setup({ canLoad: false });
    triggers.idle();
    triggers.intent();
    expect(calls).toEqual({ download: 0, build: 0 });

    state.canLoad = true;
    triggers.changed();
    expect(calls).toEqual({ download: 1, build: 1 });
  });

  it("after an idle moment in a hidden tab, downloads when shown but still waits for intent", () => {
    const { calls, state, triggers } = setup({ canLoad: false });
    triggers.idle();
    state.canLoad = true;
    triggers.changed();
    expect(calls).toEqual({ download: 1, build: 0 });
  });
});
