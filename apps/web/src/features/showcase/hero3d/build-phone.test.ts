import { describe, expect, it } from "vitest";

import { buildPhone, type BuildOutcome } from "./build-phone";
import { loadTriggers } from "./load-triggers";
import type { PhoneScene } from "./phone-scene";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets pending promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The page around one hero: the gate (`visible` tab, not `still`: a hero not pinned or Reduce
 * Motion, STILL_QUERY), the 3D chunk held pending until `chunk.resolve()`, and counts of what
 * the build spent: three.js evaluated, WebGL contexts made, scenes disposed.
 */
function page(options: { probe?: () => Promise<boolean> } = {}) {
  const env = { visible: true, still: false, stopped: false };
  const chunk = deferred<void>();
  const spent = { evaluated: 0, contexts: 0, disposed: 0, revealed: 0 };
  const scene = (): PhoneScene => ({
    setProgress() {},
    probe: options.probe ?? (async () => true),
    reveal: () => void (spent.revealed += 1),
    dispose: () => void (spent.disposed += 1),
  });
  const steps = {
    canLoad: () => !env.stopped && env.visible && !env.still,
    stopped: () => env.stopped,
    download: async () => {
      await chunk.promise;
      return () => {
        spent.evaluated += 1;
        return "createPhoneScene";
      };
    },
    breathe: async () => {},
    create: async (make: string) => {
      expect(make).toBe("createPhoneScene");
      spent.contexts += 1;
      return scene();
    },
  };
  return { env, chunk, spent, steps };
}

describe("one attempt to build the 3D phone", () => {
  it("builds when the gate stays open: three.js once, one context, then the phone", async () => {
    const { chunk, spent, steps } = page();
    const attempt = buildPhone(steps);
    chunk.resolve();
    const outcome = await attempt;
    expect(outcome.kind).toBe("ready");
    expect(spent).toEqual({ evaluated: 1, contexts: 1, disposed: 0, revealed: 0 });
  });

  it.each<[string, (env: { visible: boolean; still: boolean }) => void]>([
    ["Reduce Motion is turned on", (env) => (env.still = true)],
    ["the tab is hidden", (env) => (env.visible = false)],
    ["the hero stops being pinned (a phone turned sideways)", (env) => (env.still = true)],
  ])(
    "evaluates nothing and makes no context when %s while the chunk downloads",
    async (_, close) => {
      const { env, chunk, spent, steps } = page();
      const attempt = buildPhone(steps);
      close(env);
      chunk.resolve();
      expect((await attempt).kind).toBe("paused");
      expect(spent).toEqual({ evaluated: 0, contexts: 0, disposed: 0, revealed: 0 });
    },
  );

  it("makes no context when the gate closes between evaluating three.js and the context", async () => {
    const { env, chunk, spent, steps } = page();
    const pause = deferred<void>();
    const attempt = buildPhone({ ...steps, breathe: () => pause.promise });
    chunk.resolve();
    await settle();
    expect(spent.evaluated).toBe(1);
    env.visible = false;
    pause.resolve();
    expect((await attempt).kind).toBe("paused");
    expect(spent.contexts).toBe(0);
  });

  it("disposes the scene and hands nothing over when the gate closes during the probe", async () => {
    const probe = deferred<boolean>();
    const { env, chunk, spent, steps } = page({ probe: () => probe.promise });
    const attempt = buildPhone(steps);
    chunk.resolve();
    await settle();
    env.still = true;
    probe.resolve(true);
    expect((await attempt).kind).toBe("paused");
    expect(spent).toMatchObject({ contexts: 1, disposed: 1 });
  });

  it("stops without evaluating anything when the page goes away during the download", async () => {
    const { env, chunk, spent, steps } = page();
    const attempt = buildPhone(steps);
    env.stopped = true;
    chunk.resolve();
    expect((await attempt).kind).toBe("stopped");
    expect(spent.evaluated).toBe(0);
  });

  it("fails for good, disposing the scene, when the frames are too slow or anything throws", async () => {
    const slow = page({ probe: async () => false });
    slow.chunk.resolve();
    expect((await buildPhone(slow.steps)).kind).toBe("failed");
    expect(slow.spent.disposed).toBe(1);

    const broken = page();
    broken.chunk.reject(new Error("no WebGL 2"));
    expect((await buildPhone(broken.steps)).kind).toBe("failed");
  });
});

/**
 * The hero's loading as hero-motion.tsx wires it: the triggers, and one build attempt per run,
 * finished unless it paused. The chunk is held pending, as in the Gatekeeper's reproduction.
 */
function hero(options: { probe?: () => Promise<boolean> } = {}) {
  const site = page(options);
  const outcomes: BuildOutcome["kind"][] = [];
  const triggers = loadTriggers({
    canLoad: site.steps.canLoad,
    download: () => {},
    build: async () => {
      const outcome = await buildPhone(site.steps);
      outcomes.push(outcome.kind);
      return outcome.kind !== "paused";
    },
  });
  return { ...site, outcomes, triggers };
}

describe("a pending chunk while the gate changes (Gatekeeper round 1 on #420)", () => {
  it("with Reduce Motion turned on: nothing evaluated, no context, and the CSS phone not stranded", async () => {
    const { env, chunk, spent, outcomes, triggers } = hero();
    triggers.intent();
    env.still = true; // Reduce Motion (STILL_QUERY)
    triggers.changed();
    chunk.resolve();
    await settle();
    expect(outcomes).toEqual(["paused"]);
    expect(spent).toEqual({ evaluated: 0, contexts: 0, disposed: 0, revealed: 0 });

    env.still = false; // turned off again: the media query's change event
    triggers.changed();
    await settle();
    expect(outcomes).toEqual(["paused", "ready"]);
    expect(spent).toMatchObject({ evaluated: 1, contexts: 1 });
  });

  it("with the tab hidden, then shown again: resumes and builds once", async () => {
    const { env, chunk, spent, outcomes, triggers } = hero();
    triggers.intent();
    env.visible = false;
    triggers.changed(); // visibilitychange
    chunk.resolve();
    await settle();
    expect(outcomes).toEqual(["paused"]);
    expect(spent.evaluated).toBe(0);

    env.visible = true;
    triggers.changed(); // visibilitychange
    await settle();
    expect(outcomes).toEqual(["paused", "ready"]);
    expect(spent).toMatchObject({ evaluated: 1, contexts: 1, disposed: 0 });

    triggers.intent();
    triggers.changed();
    await settle();
    expect(spent.contexts).toBe(1);
  });

  it("with the media query changing both ways, a pause each time it closes, the phone once it stays open", async () => {
    const probe = deferred<boolean>();
    let probes = 0;
    const { env, chunk, spent, outcomes, triggers } = hero({
      probe: () => (++probes === 1 ? probe.promise : Promise.resolve(true)),
    });
    triggers.intent();
    env.still = true; // not pinned any more
    chunk.resolve();
    await settle();
    expect(outcomes).toEqual(["paused"]);

    env.still = false; // pinned again: resumes
    triggers.changed();
    await settle();
    env.still = true; // and back, while the first probe runs
    probe.resolve(true);
    await settle();
    expect(outcomes).toEqual(["paused", "paused"]);
    expect(spent).toMatchObject({ contexts: 1, disposed: 1 });

    env.still = false;
    triggers.intent(); // the next intent resumes too
    await settle();
    expect(outcomes).toEqual(["paused", "paused", "ready"]);
    expect(spent).toMatchObject({ contexts: 2, disposed: 1 });
  });
});
