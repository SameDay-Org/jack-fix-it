import { describe, expect, it } from "vitest";

import { loadTriggers } from "./load-triggers";

/** `finishes`: what each build resolves to, in turn (true when over, false when paused). */
function setup(start: { canLoad: boolean; finishes?: boolean[] }) {
  const calls = { download: 0, build: 0 };
  const state = { canLoad: start.canLoad };
  const finishes = [...(start.finishes ?? [])];
  const triggers = loadTriggers({
    canLoad: () => state.canLoad,
    download: () => (calls.download += 1),
    build: async () => {
      calls.build += 1;
      return finishes.shift() ?? true;
    },
  });
  return { calls, state, triggers };
}

/** Lets the builds' promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it("keeps the intent when a build pauses, and builds again once it can (Gatekeeper round 1 on #420)", async () => {
    const { calls, state, triggers } = setup({ canLoad: true, finishes: [false, true] });
    triggers.intent();
    state.canLoad = false; // the gate closed during the build's wait: it paused
    await settle();
    expect(calls.build).toBe(1);

    triggers.intent();
    triggers.changed();
    expect(calls.build).toBe(1); // not while the gate is closed

    state.canLoad = true;
    triggers.changed(); // shown again, or the media query changed back
    await settle();
    expect(calls.build).toBe(2);
    triggers.intent();
    triggers.changed();
    await settle();
    expect(calls.build).toBe(2); // over: never again
  });

  it("resumes a paused build at once when the gate is already open again", async () => {
    const { calls, triggers } = setup({ canLoad: true, finishes: [false, true] });
    triggers.intent();
    await settle();
    expect(calls.build).toBe(2);
  });

  it("resumes a paused build on the next intent too", async () => {
    const { calls, state, triggers } = setup({ canLoad: true, finishes: [false, true] });
    triggers.intent();
    state.canLoad = false;
    await settle();
    state.canLoad = true;
    triggers.intent();
    await settle();
    expect(calls.build).toBe(2);
  });

  it("never runs two builds at once", async () => {
    const { calls, triggers } = setup({ canLoad: true });
    triggers.intent();
    triggers.intent();
    triggers.changed();
    expect(calls.build).toBe(1);
    await settle();
    expect(calls.build).toBe(1);
  });

  it("after an idle moment in a hidden tab, downloads when shown but still waits for intent", () => {
    const { calls, state, triggers } = setup({ canLoad: false });
    triggers.idle();
    state.canLoad = true;
    triggers.changed();
    expect(calls).toEqual({ download: 1, build: 0 });
  });
});
