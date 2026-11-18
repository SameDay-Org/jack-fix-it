import { arm, type ArmPose } from "./parts/arms.ts";
import { belt, legs, neck, shirt } from "./parts/body.ts";
import { expression, type Expression } from "./parts/face.ts";
import { hat } from "./parts/hat.ts";
import { cheeks, ears, face, hair, nose } from "./parts/head.ts";
import { toolbox, wrench } from "./parts/props.ts";
import { group, type Group, type Side } from "./shapes.ts";

/**
 * The poses a page may ask for: the public contract of the `Mascot` component the showcase
 * already uses (apps/web/src/features/mascot/mascot.tsx). A test keeps the two lists equal.
 */
export const MASCOT_POSES = ["wave", "point", "celebrate", "peek", "thinking", "tools"] as const;

export type MascotPose = (typeof MASCOT_POSES)[number];

/** The poses drawn so far (#404 PR 1); point, peek and thinking come with the animation. */
export const READY_POSES = ["wave", "celebrate", "tools"] as const satisfies readonly MascotPose[];

export type ReadyPose = (typeof READY_POSES)[number];

type PoseSpec = {
  expression: Expression;
  /** Degrees, around the neck: a little life in the stance. */
  headTilt: number;
  arms: Record<Side, ArmPose>;
};

/** An arm hanging at ease, in front of the body's side. */
const RELAXED: ArmPose = { upper: 17, lower: 9, glove: "fist", layer: "front" };

const SPECS: Record<ReadyPose, PoseSpec> = {
  // Hello: one open glove up beside the head, the head leaning into it.
  wave: {
    expression: "smile",
    headTilt: 4,
    arms: {
      left: RELAXED,
      right: { upper: 125, lower: 160, glove: "open", layer: "back" },
    },
  },
  // Job done: both fists up.
  celebrate: {
    expression: "happy",
    headTilt: 0,
    arms: {
      left: { upper: 140, lower: 165, glove: "fist", layer: "back" },
      right: { upper: 140, lower: 165, glove: "fist", layer: "back" },
    },
  },
  // At work: the toolbox in one hand, a wrench raised in the other.
  tools: {
    expression: "smile",
    headTilt: -3,
    arms: {
      left: {
        upper: 8,
        lower: 4,
        glove: "fist",
        layer: "front",
        hold: { node: toolbox(), rotate: -4 },
      },
      right: {
        upper: 40,
        lower: 150,
        glove: "fist",
        layer: "back",
        hold: { node: wrench(), rotate: 12 },
      },
    },
  },
};

function head(spec: PoseSpec): Group {
  return group(
    "head",
    [ears(), face(), hair(), cheeks(), nose(), expression(spec.expression), hat()],
    spec.headTilt ? `rotate(${spec.headTilt} 100 96)` : undefined,
  );
}

/** One pose as a tree of named parts (shapes.ts), drawn back to front. */
export function poseNode(pose: ReadyPose): Group {
  const spec = SPECS[pose];
  const sides: Side[] = ["left", "right"];
  const arms = (layer: ArmPose["layer"]) =>
    sides
      .filter((side) => spec.arms[side].layer === layer)
      .map((side) => arm(side, spec.arms[side]));
  return group(`pose-${pose}`, [
    group("arms-back", arms("back")),
    legs(),
    group("torso", [neck(), shirt(), belt()]),
    head(spec),
    group("arms-front", arms("front")),
  ]);
}

export function isReadyPose(pose: string): pose is ReadyPose {
  return (READY_POSES as readonly string[]).includes(pose);
}
