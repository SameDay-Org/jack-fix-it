import { RIGS, rigNode } from "./rig.ts";
import type { Group } from "./shapes.ts";

/**
 * The poses a page may ask for: the public contract of the `Mascot` component the showcase
 * already uses (apps/web/src/features/mascot/mascot.tsx). A test keeps the two lists equal.
 */
export const MASCOT_POSES = ["wave", "point", "celebrate", "peek", "thinking", "tools"] as const;

export type MascotPose = (typeof MASCOT_POSES)[number];

/** The poses drawn: all six since #404 PR 2. */
export const READY_POSES = MASCOT_POSES;

export type ReadyPose = MascotPose;

/** One pose as a tree of named parts (shapes.ts), drawn back to front. */
export function poseNode(pose: MascotPose): Group {
  return rigNode(RIGS[pose]);
}

export function isReadyPose(pose: string): pose is MascotPose {
  return (MASCOT_POSES as readonly string[]).includes(pose);
}
