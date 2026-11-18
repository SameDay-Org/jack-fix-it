import type { PhoneScene } from "./phone-scene";

/**
 * One attempt to build the 3D phone (#403 PR 2), step by step, with the hero's loading gate
 * (`canLoad`: a pinned hero, in a tab the reader sees, without Reduce Motion) checked again
 * after every wait: the chunk's download, the pause between evaluating three.js and making the
 * WebGL context, the context and the frame-time probe. Whatever changed meanwhile, nothing more
 * is spent once the reader has opted out or left the tab (Gatekeeper round 1 on #420).
 *
 * - `ready`: the phone can replace the CSS one;
 * - `paused`: the gate closed during a wait; nothing more was done (a scene already made is
 *   disposed), and the caller tries again when the gate may have opened (load-triggers.ts);
 * - `failed`: no WebGL 2, frames too slow, or an error: the CSS phone stays for good;
 * - `stopped`: the page went away.
 */
export type BuildOutcome =
  | { kind: "ready"; scene: PhoneScene }
  | { kind: "paused" }
  | { kind: "failed" }
  | { kind: "stopped" };

export type BuildSteps<Make> = {
  canLoad(): boolean;
  stopped(): boolean;
  /** The 3D chunk (downloaded once): resolves to what evaluates three.js inside it. */
  download(): Promise<() => Make>;
  /** One task's pause, so evaluating three.js and making the context are two shorter tasks. */
  breathe(): Promise<void>;
  /** Makes the scene: the WebGL context, the model, the screens. */
  create(make: Make): Promise<PhoneScene>;
};

export async function buildPhone<Make>(steps: BuildSteps<Make>): Promise<BuildOutcome> {
  // After each wait: the page gone, or the gate closed (the reader opted out or left).
  const halted = (): BuildOutcome | null => {
    if (steps.stopped()) return { kind: "stopped" };
    return steps.canLoad() ? null : { kind: "paused" };
  };
  let scene: PhoneScene | null = null;
  try {
    const evaluate = await steps.download();
    let halt = halted();
    if (halt) return halt;
    const make = evaluate(); // evaluates three.js

    await steps.breathe();
    halt = halted();
    if (halt) return halt;
    scene = await steps.create(make); // the WebGL context

    halt = halted();
    if (halt) {
      scene.dispose();
      return halt;
    }
    const smooth = await scene.probe();
    halt = halted();
    if (halt || !smooth) {
      scene.dispose();
      return halt ?? { kind: "failed" };
    }
    return { kind: "ready", scene };
  } catch {
    scene?.dispose();
    return steps.stopped() ? { kind: "stopped" } : { kind: "failed" };
  }
}
