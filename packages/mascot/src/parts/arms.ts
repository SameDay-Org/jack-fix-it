import { group, round, type Group, type MascotNode, type RectShape, type Side } from "../shapes.ts";
import { SHOULDER } from "./body.ts";

/**
 * The arms, as a small rig: an arm is two angles (the upper arm's and the forearm's, in degrees
 * from hanging straight down, positive away from the body) and a glove. The sleeve is navy, the
 * forearm bare, the work gloves lime. Every pose is these few numbers, not a new drawing.
 */

export type Glove = "fist" | "open";

/** Something held in a fist: drawn with its grip point at (0, 0), turned by `rotate`. */
export type Held = { node: MascotNode; rotate: number };

export type ArmPose = {
  upper: number;
  lower: number;
  glove: Glove;
  /** `front` draws the arm over the body (a hand before the chest or the legs). */
  layer: "back" | "front";
  hold?: Held;
};

const UPPER = { length: 24, width: 16.5 } as const;
const LOWER = { length: 23, width: 12 } as const;
/** From the wrist to the middle of the fist, along the forearm. */
const GRIP = 9.5;

type Point = { x: number; y: number };

/** Outward is to the viewer's left for the left arm, to the right for the right one. */
const OUTWARD: Record<Side, number> = { left: -1, right: 1 };

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function along(from: Point, angle: number, length: number, side: Side): Point {
  return {
    x: round(from.x + OUTWARD[side] * Math.sin(radians(angle)) * length),
    y: round(from.y + Math.cos(radians(angle)) * length),
  };
}

/** SVG turns clockwise: a limb hanging down, turned by this, points along `angle`. */
function turn(angle: number, side: Side): number {
  return round(-OUTWARD[side] * angle);
}

/** A rounded limb from `from`, along `angle`. */
function limb(
  from: Point,
  angle: number,
  size: { length: number; width: number },
  side: Side,
  fill: RectShape["fill"],
): RectShape {
  return {
    tag: "rect",
    x: round(from.x - size.width / 2),
    y: round(from.y - size.width / 2),
    width: size.width,
    height: size.length + size.width,
    rx: size.width / 2,
    fill,
    transform: `rotate(${turn(angle, side)} ${from.x} ${from.y})`,
  };
}

/** A glove drawn pointing down from the wrist at (0, 0); the thumb on the body's side. */
function glove(kind: Glove, side: Side): MascotNode[] {
  const thumb = -OUTWARD[side];
  const cuff: RectShape = {
    tag: "rect",
    x: -7.5,
    y: -1.5,
    width: 15,
    height: 5.5,
    rx: 2.75,
    fill: "green700",
  };
  if (kind === "fist") {
    return [
      cuff,
      { tag: "ellipse", cx: thumb * 7.2, cy: 6.4, rx: 3.3, ry: 4.6, fill: "green500" },
      { tag: "rect", x: -8, y: 2.5, width: 16, height: 14, rx: 6.5, fill: "green500" },
      // Where the fingers fold.
      { tag: "rect", x: -5, y: 11.6, width: 10, height: 1.7, rx: 0.85, fill: "green700" },
    ];
  }
  const finger = (x: number, length: number): RectShape => ({
    tag: "rect",
    x: x - 1.95,
    y: 8,
    width: 3.9,
    height: length,
    rx: 1.95,
    fill: "green500",
  });
  return [
    cuff,
    finger(-5.9, 11),
    finger(-2, 13),
    finger(1.9, 12.4),
    finger(5.8, 10),
    { tag: "rect", x: -7.6, y: 2.5, width: 15.2, height: 11.5, rx: 5, fill: "green500" },
    // The thumb, opened out.
    {
      tag: "rect",
      x: thumb * 7.2 - 2,
      y: 3,
      width: 4,
      height: 10,
      rx: 2,
      fill: "green500",
      transform: `rotate(${thumb * -38} ${thumb * 7.2} 4)`,
    },
  ];
}

/** One arm from its shoulder, with what it holds. */
export function arm(side: Side, pose: ArmPose): Group {
  const shoulder = SHOULDER[side];
  const elbow = along(shoulder, pose.upper, UPPER.length, side);
  const wrist = along(elbow, pose.lower, LOWER.length, side);
  const fist = along(wrist, pose.lower, GRIP, side);
  const held: MascotNode[] = pose.hold
    ? [
        group(
          "held",
          [pose.hold.node],
          `translate(${fist.x} ${fist.y}) rotate(${pose.hold.rotate})`,
        ),
      ]
    : [];
  return group(`arm-${side}`, [
    limb(elbow, pose.lower, LOWER, side, "skin"),
    limb(shoulder, pose.upper, UPPER, side, "navy700"),
    // The rolled cuff of the sleeve, at the elbow.
    {
      tag: "rect",
      x: round(elbow.x - 9.25),
      y: round(elbow.y - 3),
      width: 18.5,
      height: 6,
      rx: 3,
      fill: "navy900",
      transform: `rotate(${turn(pose.upper, side)} ${elbow.x} ${elbow.y})`,
    },
    ...held,
    group(
      `glove-${pose.glove}`,
      glove(pose.glove, side),
      `translate(${wrist.x} ${wrist.y}) rotate(${turn(pose.lower, side)})`,
    ),
  ]);
}
