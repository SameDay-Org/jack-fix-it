import { group, type Group } from "../shapes.ts";

/**
 * The props, in the same flat style: each drawn with the point a fist grips at (0, 0), so a pose
 * can put it in a hand (arms.ts), and the showcase can place it on its own.
 */

/** An open-end wrench, head up, gripped halfway down its handle. */
export function wrench(): Group {
  return group("prop-wrench", [
    { tag: "rect", x: -3.3, y: -19, width: 6.6, height: 37, rx: 3.3, fill: "metal" },
    { tag: "rect", x: -1, y: -13, width: 2, height: 26, rx: 1, fill: "metalShade" },
    // The ring at the end of the handle.
    { tag: "circle", cx: 0, cy: 19, r: 5.2, fill: "metal" },
    { tag: "circle", cx: 0, cy: 19, r: 2.2, fill: "metalShade" },
    // The open jaw.
    {
      tag: "path",
      d: "M3.6-32.3V-26H-3.6V-32.3A8.6 8.6 0 1 0 3.6-32.3Z",
      fill: "metal",
    },
  ]);
}

/** A lime toolbox, held by its handle. */
export function toolbox(): Group {
  return group("prop-toolbox", [
    {
      tag: "path",
      d: "M-9.5 5.5V1C-9.5-4.2-5.6-6.5 0-6.5S9.5-4.2 9.5 1V5.5H5.8V1.4C5.8-1.4 3.6-2.8 0-2.8S-5.8-1.4-5.8 1.4V5.5Z",
      fill: "navy900",
    },
    { tag: "rect", x: -19, y: 5, width: 38, height: 25, rx: 4, fill: "green500" },
    // The lid.
    { tag: "rect", x: -19, y: 5, width: 38, height: 9, rx: 4, fill: "green700" },
    { tag: "rect", x: -19, y: 10, width: 38, height: 4, fill: "green700" },
    // The latch.
    { tag: "rect", x: -3.6, y: 11, width: 7.2, height: 6.5, rx: 1.6, fill: "navy900" },
  ]);
}

/** A clipboard with a ticked list, held at its middle. */
export function clipboard(): Group {
  return group("prop-clipboard", [
    { tag: "rect", x: -14, y: -18, width: 28, height: 36, rx: 3.5, fill: "navy700" },
    { tag: "rect", x: -11, y: -13, width: 22, height: 28, rx: 1.6, fill: "white" },
    // The clip.
    { tag: "rect", x: -6.5, y: -21, width: 13, height: 7, rx: 2.4, fill: "green500" },
    { tag: "rect", x: -3, y: -23.5, width: 6, height: 4.5, rx: 2.2, fill: "green700" },
    // A tick and three lines.
    {
      tag: "path",
      d: "M-9.4-6.6L-8.1-7.9L-6.6-6.4L-3.7-9.3L-2.4-8L-6.6-3.8Z",
      fill: "green700",
    },
    { tag: "rect", x: -1, y: -8, width: 9, height: 2.2, rx: 1.1, fill: "gray500" },
    { tag: "rect", x: -8, y: -1, width: 16, height: 2.2, rx: 1.1, fill: "gray500" },
    { tag: "rect", x: -8, y: 5, width: 12, height: 2.2, rx: 1.1, fill: "gray500" },
  ]);
}

/** The props a fist can hold, by name: a pose (rig.ts) names one, and stays plain data. */
export const PROPS = { wrench, toolbox, clipboard } as const;

export type PropName = keyof typeof PROPS;

/**
 * A lime question mark beside the head, for `thinking`: drawn around (0, 0), about 26 units
 * tall, with a small dot under it.
 */
export function question(): Group {
  return group("prop-question", [
    {
      tag: "path",
      d: "M-7.5-8.2C-7.5-14.4-3.6-17.5 0.6-17.5C5.4-17.5 8.6-14.4 8.6-10.1C8.6-6.3 6.2-4.5 4-3C2.3-1.9 1.8-1 1.8 0.9V2.6H-3.2V0.5C-3.2-2.7-1.8-4.4 0.4-5.9C2.4-7.3 3.4-8.2 3.4-10C3.4-11.8 2.2-13 0.4-13C-1.6-13-2.8-11.6-2.8-8.6Z",
      fill: "green500",
    },
    { tag: "circle", cx: -0.7, cy: 7.6, r: 2.9, fill: "green500" },
  ]);
}
