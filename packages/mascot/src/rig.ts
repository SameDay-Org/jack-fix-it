import { arm, type ArmPose } from "./parts/arms.ts";
import { belt, legs, neck, shirt } from "./parts/body.ts";
import { expression, type Expression } from "./parts/face.ts";
import { hat } from "./parts/hat.ts";
import { cheeks, ears, face, hair, nose } from "./parts/head.ts";
import { question } from "./parts/props.ts";
import { group, round, type Group, type MascotNode, type Side } from "./shapes.ts";

/**
 * A pose as plain numbers and names: what `rigNode` draws, and what a pose change moves from
 * one value to the next (`interpolateRig`), the same layers all the way, never a cross-fade.
 * Plain data, so the app can draw the same rig with react-native-svg.
 */
export type PoseRig = {
  expression: Expression;
  /** Degrees, around the neck. */
  headTilt: number;
  /** The whole body moved and leaned, around the feet: `peek` comes in from the side. */
  lean: { x: number; y: number; rotate: number };
  arms: Record<Side, ArmPose>;
  /** A question mark beside the head. */
  thought: boolean;
};

const UPRIGHT = { x: 0, y: 0, rotate: 0 } as const;

/** An arm hanging at ease, in front of the body's side. */
const RELAXED: ArmPose = { upper: 17, lower: 9, glove: "fist", layer: "front" };

/** The six poses of the public contract (poses.ts). */
export const RIGS = {
  // Hello: one open glove up beside the head, the head leaning into it.
  wave: {
    expression: "smile",
    headTilt: 4,
    lean: UPRIGHT,
    arms: { left: RELAXED, right: { upper: 125, lower: 160, glove: "open", layer: "back" } },
    thought: false,
  },
  // This way: an arm out to the side, the index finger pointing.
  point: {
    expression: "smile",
    headTilt: 3,
    lean: UPRIGHT,
    arms: { left: RELAXED, right: { upper: 74, lower: 88, glove: "point", layer: "back" } },
    thought: false,
  },
  // Job done: both fists up.
  celebrate: {
    expression: "happy",
    headTilt: 0,
    lean: UPRIGHT,
    arms: {
      left: { upper: 140, lower: 165, glove: "fist", layer: "back" },
      right: { upper: 140, lower: 165, glove: "fist", layer: "back" },
    },
    thought: false,
  },
  // Coming in from the right edge, leaning, a small hello: the rest of him is out of frame.
  peek: {
    expression: "smile",
    headTilt: -6,
    lean: { x: 96, y: 4, rotate: -16 },
    arms: {
      left: { upper: 58, lower: 150, glove: "open", layer: "front" },
      right: RELAXED,
    },
    thought: false,
  },
  // Weighing the job: a fist under the chin, the other arm across, a question mark.
  thinking: {
    expression: "thinking",
    headTilt: -5,
    lean: UPRIGHT,
    arms: {
      left: { upper: 10, lower: -95, glove: "fist", layer: "front" },
      right: { upper: -20, lower: -161, glove: "fist", layer: "front" },
    },
    thought: true,
  },
  // At work: the toolbox in one hand, a wrench raised in the other.
  tools: {
    expression: "smile",
    headTilt: -3,
    lean: UPRIGHT,
    arms: {
      left: { ...RELAXED, upper: 8, lower: 4, hold: { prop: "toolbox", rotate: -4 } },
      right: {
        upper: 40,
        lower: 150,
        glove: "fist",
        layer: "back",
        hold: { prop: "wrench", rotate: 12 },
      },
    },
    thought: false,
  },
} as const satisfies Record<string, PoseRig>;

function head(rig: PoseRig): Group {
  return group(
    "head",
    [ears(), face(), hair(), cheeks(), nose(), expression(rig.expression), hat()],
    rig.headTilt ? `rotate(${round(rig.headTilt)} 100 96)` : undefined,
  );
}

function leanTransform({ x, y, rotate }: PoseRig["lean"]): string | undefined {
  if (!x && !y && !rotate) return undefined;
  return `translate(${round(x)} ${round(y)}) rotate(${round(rotate)} 100 196)`;
}

/**
 * A rig as a tree of named parts (shapes.ts), back to front. `upper` (arms, torso, head) has no
 * transform of its own, so a CSS animation can move it (the idle breathing, motion.ts).
 */
export function rigNode(rig: PoseRig): Group {
  const sides: Side[] = ["left", "right"];
  const arms = (layer: ArmPose["layer"]) =>
    sides.filter((side) => rig.arms[side].layer === layer).map((side) => arm(side, rig.arms[side]));
  const body = group(
    "lean",
    [
      legs(),
      group("upper", [
        group("arms-back", arms("back")),
        group("torso", [neck(), shirt(), belt()]),
        head(rig),
        group("arms-front", arms("front")),
      ]),
    ],
    leanTransform(rig.lean),
  );
  const extras: MascotNode[] = rig.thought
    ? [group("thought", [question()], "translate(53 33)")]
    : [];
  return group("mascot", [body, ...extras]);
}

/** Slow in, slow out. */
export function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function mix(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function mixArm(from: ArmPose, to: ArmPose, k: number): ArmPose {
  const late = k >= 0.5;
  const hold = late ? to.hold : from.hold;
  const keepsProp = from.hold && to.hold && from.hold.prop === to.hold.prop;
  return {
    upper: mix(from.upper, to.upper, k),
    lower: mix(from.lower, to.lower, k),
    glove: late ? to.glove : from.glove,
    layer: late ? to.layer : from.layer,
    ...(hold
      ? {
          hold: keepsProp
            ? { prop: hold.prop, rotate: mix(from.hold!.rotate, to.hold!.rotate, k) }
            : hold,
        }
      : {}),
  };
}

/**
 * The rig `t` of the way from `from` to `to` (0 to 1, eased): every number moves; what cannot
 * move by degrees (the expression, a glove's shape, which layer an arm is on, a prop, the
 * question mark) changes halfway.
 */
export function interpolateRig(from: PoseRig, to: PoseRig, t: number): PoseRig {
  const k = ease(t);
  const late = k >= 0.5;
  return {
    expression: late ? to.expression : from.expression,
    headTilt: mix(from.headTilt, to.headTilt, k),
    lean: {
      x: mix(from.lean.x, to.lean.x, k),
      y: mix(from.lean.y, to.lean.y, k),
      rotate: mix(from.lean.rotate, to.lean.rotate, k),
    },
    arms: {
      left: mixArm(from.arms.left, to.arms.left, k),
      right: mixArm(from.arms.right, to.arms.right, k),
    },
    thought: late ? to.thought : from.thought,
  };
}
