import type { MediaId } from "../media";

/**
 * The hero's scroll story, as plain numbers (#403 PR 2). The hero is pinned while the reader
 * scrolls through it; `p` runs from 0 (the hero's top at the viewport's top) to 1 (its end at
 * the viewport's bottom). Everything that moves (the headline's beat, the phone's screen, the
 * phone's pose) is a function of `p` alone, so scrolling back plays the story backwards and
 * the browser's own scrolling is never touched.
 */

/** The app screens the phone shows, in order (ids of the media manifest). */
export const HERO_SCREEN_IDS = [
  "home",
  "describe",
  "quotes",
  "pay",
  "track",
] as const satisfies readonly MediaId[];

/** Where each headline beat starts: the brand line, then quotes, then paying and tracking. */
export const BEAT_STARTS = [0, 0.3, 0.65] as const;
export type Beat = 0 | 1 | 2;

/** Where each screen starts: home with the first beat, two screens for each later beat. */
export const SCREEN_STARTS = [0, 0.3, 0.475, 0.65, 0.825] as const;

/** The share of `p` a cross-fade between two screens takes, centred on the next one's start. */
export const SCREEN_FADE = 0.06;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 0 to 1 with zero speed at both ends. */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * How far the reader is through the pinned hero. `top` and `height` are the section's box
 * (its top relative to the viewport, from getBoundingClientRect), `stickTop` is where its
 * sticky stage stops (below the site's header) and `stageHeight` the stage's height. 0 while
 * the stage has not stuck yet, 1 once it lets go; 0 when nothing is pinned (the section is no
 * taller than its stage).
 */
export function pinProgress(
  top: number,
  height: number,
  stickTop: number,
  stageHeight: number,
): number {
  const range = height - stageHeight;
  if (range <= 0) return 0;
  return clamp((stickTop - top) / range, 0, 1);
}

export function beatAt(p: number): Beat {
  if (p >= BEAT_STARTS[2]) return 2;
  if (p >= BEAT_STARTS[1]) return 1;
  return 0;
}

/** The screen on show (`index`), the one fading in over it (`next`) and how far (`blend`). */
export type ScreenMix = { index: number; next: number; blend: number };

export function screenAt(p: number): ScreenMix {
  for (let k = 1; k < SCREEN_STARTS.length; k += 1) {
    const from = SCREEN_STARTS[k] - SCREEN_FADE / 2;
    if (p <= from) return { index: k - 1, next: k - 1, blend: 0 };
    if (p < from + SCREEN_FADE) {
      return { index: k - 1, next: k, blend: smoothstep((p - from) / SCREEN_FADE) };
    }
  }
  const last = SCREEN_STARTS.length - 1;
  return { index: last, next: last, blend: 0 };
}

/** The screen that covers most of the glass: what the phone drawn in CSS shows. */
export function dominantScreen(p: number): number {
  const { index, next, blend } = screenAt(p);
  return blend >= 0.5 ? next : index;
}

/**
 * The phone's pose: its rotation around each axis (radians) and `fill`, the share of the
 * canvas height the phone takes (the camera moves in or out to get it).
 */
export type PhonePose = { rotX: number; rotY: number; rotZ: number; fill: number };

/** Facing the reader, at the size of the phone drawn in CSS: where the 3D phone fades in. */
export const FRONT_POSE: PhonePose = { rotX: 0, rotY: 0, rotZ: 0, fill: 0.74 };

/**
 * Turned to show its titanium edge, then square to the reader while the camera moves in
 * until the screen fills the view (the paying and tracking screens), then turning away a
 * little as the hero lets go.
 */
export const POSE_KEYS: readonly { at: number; pose: PhonePose }[] = [
  { at: 0, pose: { rotX: 0.16, rotY: -0.55, rotZ: 0.05, fill: 0.74 } },
  { at: 0.3, pose: { rotX: 0.05, rotY: -0.14, rotZ: 0.01, fill: 0.82 } },
  { at: 0.65, pose: { rotX: 0, rotY: 0, rotZ: 0, fill: 0.95 } },
  { at: 0.85, pose: { rotX: 0, rotY: 0.04, rotZ: 0, fill: 0.95 } },
  { at: 1, pose: { rotX: -0.06, rotY: 0.3, rotZ: -0.03, fill: 0.84 } },
];

export function mixPose(a: PhonePose, b: PhonePose, t: number): PhonePose {
  const mix = (x: number, y: number) => x + (y - x) * t;
  return {
    rotX: mix(a.rotX, b.rotX),
    rotY: mix(a.rotY, b.rotY),
    rotZ: mix(a.rotZ, b.rotZ),
    fill: mix(a.fill, b.fill),
  };
}

export function poseAt(p: number): PhonePose {
  const x = clamp(p, 0, 1);
  for (let k = 1; k < POSE_KEYS.length; k += 1) {
    const from = POSE_KEYS[k - 1];
    const to = POSE_KEYS[k];
    if (x <= to.at)
      return mixPose(from.pose, to.pose, smoothstep((x - from.at) / (to.at - from.at)));
  }
  return POSE_KEYS[POSE_KEYS.length - 1].pose;
}
