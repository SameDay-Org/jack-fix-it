import { describe, expect, it } from "vitest";

import { MEDIA_IDS } from "../media";

import {
  BEAT_STARTS,
  beatAt,
  dominantScreen,
  HERO_SCREEN_IDS,
  pinProgress,
  POSE_KEYS,
  poseAt,
  revealPose,
  SCREEN_FADE,
  SCREEN_STARTS,
  screenAt,
  START_POSE,
  type PhonePose,
} from "./choreography";

/** Every `step` from 0 to 1, both ends included. */
function steps(step: number): number[] {
  const count = Math.round(1 / step);
  return Array.from({ length: count + 1 }, (_, i) => i / count);
}

describe("pinProgress", () => {
  // A 2000 px section with a 736 px stage that sticks 64 px from the top (below the header).
  const at = (top: number) => pinProgress(top, 2000, 64, 736);

  it("is 0 until the stage sticks, 1 once it lets go, and linear between", () => {
    expect(at(64)).toBe(0);
    expect(at(500)).toBe(0);
    expect(at(64 - 632)).toBeCloseTo(0.5);
    expect(at(64 - 1264)).toBe(1);
    expect(at(-5000)).toBe(1);
  });

  it("is 0 when nothing is pinned (the section is no taller than its stage)", () => {
    expect(pinProgress(-300, 736, 64, 736)).toBe(0);
    expect(pinProgress(-300, 500, 64, 736)).toBe(0);
  });
});

describe("headline beats", () => {
  it("are three, in order, from the top of the hero", () => {
    expect(BEAT_STARTS[0]).toBe(0);
    expect(steps(0.01).map(beatAt)).toEqual([...steps(0.01).map(beatAt)].sort());
    expect([beatAt(0), beatAt(0.29), beatAt(0.3), beatAt(0.64), beatAt(0.65), beatAt(1)]).toEqual([
      0, 0, 1, 1, 2, 2,
    ]);
  });
});

describe("phone screens", () => {
  it("are app captures of the manifest, the home screen first", () => {
    expect(HERO_SCREEN_IDS[0]).toBe("home");
    for (const id of HERO_SCREEN_IDS) expect(MEDIA_IDS).toContain(id);
    expect(SCREEN_STARTS).toHaveLength(HERO_SCREEN_IDS.length);
  });

  it("change with the beats: home with the first, two screens with each later one", () => {
    expect(SCREEN_STARTS[1]).toBe(BEAT_STARTS[1]);
    expect(SCREEN_STARTS[3]).toBe(BEAT_STARTS[2]);
  });

  it("each show in turn, never going back while the reader scrolls on", () => {
    const shown = steps(0.001).map(dominantScreen);
    expect([...new Set(shown)]).toEqual([0, 1, 2, 3, 4]);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
  });

  it("cross-fade only around a start, from one screen to the next", () => {
    for (const p of steps(0.001)) {
      const { index, next, blend } = screenAt(p);
      expect(blend).toBeGreaterThanOrEqual(0);
      expect(blend).toBeLessThanOrEqual(1);
      if (blend > 0) {
        expect(next).toBe(index + 1);
        expect(Math.abs(p - SCREEN_STARTS[next])).toBeLessThanOrEqual(SCREEN_FADE / 2);
      } else {
        expect(next).toBe(index);
      }
    }
    expect(screenAt(SCREEN_STARTS[2]).blend).toBeCloseTo(0.5);
  });
});

describe("phone pose", () => {
  const distance = (a: PhonePose, b: PhonePose) =>
    Math.max(
      Math.abs(a.rotX - b.rotX),
      Math.abs(a.rotY - b.rotY),
      Math.abs(a.rotZ - b.rotZ),
      Math.abs(a.fill - b.fill),
    );

  it("passes through every key pose at its place", () => {
    for (const key of POSE_KEYS) expect(distance(poseAt(key.at), key.pose)).toBeLessThan(1e-9);
  });

  it("moves without jumps (the story follows the scroll smoothly)", () => {
    const poses = steps(0.001).map(poseAt);
    for (let i = 1; i < poses.length; i += 1) {
      expect(distance(poses[i - 1], poses[i])).toBeLessThan(0.01);
    }
  });

  it("starts turned to show the band (the CSS phone's pose) and stays put outside 0 to 1", () => {
    expect(poseAt(0).rotY).toBeLessThan(-0.3);
    expect(poseAt(0)).toEqual(START_POSE);
    expect(poseAt(-1)).toEqual(poseAt(0));
    expect(poseAt(2)).toEqual(poseAt(1));
  });

  it("faces the reader and fills the view while paying and tracking (the last beat)", () => {
    for (const p of [0.65, 0.7, 0.8, 0.85]) {
      const pose = poseAt(p);
      expect(Math.abs(pose.rotY)).toBeLessThan(0.05);
      expect(pose.fill).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("takes the CSS phone's start pose from the story's first key, turned to the left", () => {
    expect(START_POSE).toBe(POSE_KEYS[0].pose);
    expect(START_POSE.rotY).toBeLessThan(0);
  });
});

describe("the 3D phone's hand-over (the reveal)", () => {
  const SCROLLS = [0, 0.05, 0.3, 0.5, 0.8, 1];

  it("starts where the CSS phone stands, whatever the scroll", () => {
    for (const p of SCROLLS) expect(revealPose(p, 0)).toEqual(START_POSE);
    // The reveal has not started: a negative time is the same first frame.
    expect(revealPose(0.5, -1)).toEqual(START_POSE);
  });

  it("does not turn at all on a fresh load (no scroll yet)", () => {
    for (const t of [0, 0.25, 0.5, 1, 2]) expect(revealPose(0, t)).toEqual(START_POSE);
  });

  it("ends on the scroll's pose and keeps it", () => {
    // Equal up to the mix's rounding (a + (b - a) * 1 is b within 1e-16).
    const near = (a: PhonePose, b: PhonePose) =>
      Math.max(...(["rotX", "rotY", "rotZ", "fill"] as const).map((k) => Math.abs(a[k] - b[k])));
    for (const p of SCROLLS) {
      expect(near(revealPose(p, 1), poseAt(p))).toBeLessThan(1e-12);
      expect(near(revealPose(p, 3), poseAt(p))).toBeLessThan(1e-12);
    }
  });

  it("turns smoothly between the two, frame after frame", () => {
    const pose = (t: number) => revealPose(0.8, t);
    for (let t = 0.01; t <= 1; t += 0.01) {
      const [a, b] = [pose(t - 0.01), pose(t)];
      expect(Math.abs(a.rotY - b.rotY) + Math.abs(a.fill - b.fill)).toBeLessThan(0.03);
    }
  });
});
