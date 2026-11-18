import { describe, expect, it } from "vitest";

import { MASCOT_POSES } from "./poses.ts";
import { ease, interpolateRig, RIGS, rigNode } from "./rig.ts";
import { partsOf } from "./shapes.ts";

const count = (parts: string[], name: string) => parts.filter((part) => part === name).length;

describe("a pose change", () => {
  it("starts on the first pose and ends on the second", () => {
    expect(interpolateRig(RIGS.wave, RIGS.celebrate, 0)).toEqual(RIGS.wave);
    expect(interpolateRig(RIGS.wave, RIGS.celebrate, 1)).toEqual(RIGS.celebrate);
  });

  it.each(MASCOT_POSES.flatMap((from) => MASCOT_POSES.map((to) => [from, to] as const)))(
    "%s to %s moves the same layers: one body all the way, never two pictures",
    (from, to) => {
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const parts = partsOf(rigNode(interpolateRig(RIGS[from], RIGS[to], t)));
        for (const layer of [
          "mascot",
          "lean",
          "legs",
          "upper",
          "torso",
          "head",
          "hat",
          "arm-left",
          "arm-right",
        ]) {
          expect(count(parts, layer)).toBe(1);
        }
      }
    },
  );

  it("moves every number by degrees, the arms through the angles between", () => {
    const mid = interpolateRig(RIGS.wave, RIGS.celebrate, 0.5);
    for (const side of ["left", "right"] as const) {
      const [a, b] = [RIGS.wave.arms[side].upper, RIGS.celebrate.arms[side].upper];
      expect(mid.arms[side].upper).toBeGreaterThanOrEqual(Math.min(a, b));
      expect(mid.arms[side].upper).toBeLessThanOrEqual(Math.max(a, b));
    }
    const early = interpolateRig(RIGS.wave, RIGS.celebrate, 0.25);
    expect(early.arms.left.upper).not.toBe(RIGS.wave.arms.left.upper);
    expect(early.arms.left.upper).not.toBe(RIGS.celebrate.arms.left.upper);
  });

  it("changes what cannot move by degrees halfway: the face, the gloves, the props", () => {
    expect(interpolateRig(RIGS.tools, RIGS.thinking, 0.4)).toMatchObject({
      expression: "smile",
      thought: false,
    });
    const late = interpolateRig(RIGS.tools, RIGS.thinking, 0.6);
    expect(late).toMatchObject({ expression: "thinking", thought: true });
    expect(late.arms.right.hold).toBeUndefined();
    expect(interpolateRig(RIGS.wave, RIGS.point, 0.6).arms.right.glove).toBe("point");
  });

  it("eases in and out", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
  });
});
