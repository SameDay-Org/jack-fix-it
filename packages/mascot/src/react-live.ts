"use client";

import { createElement, useEffect, useId, useRef, useState, type ReactElement } from "react";

import { idleCss, motionScope, transition, type MotionState } from "./motion.ts";
import { mascotSvg, type MascotProps } from "./react-svg.ts";
import { RIGS, rigNode, type PoseRig } from "./rig.ts";
import { watchMotion } from "./watch.ts";

const FRAMES = {
  request: (callback: (time: number) => void) => requestAnimationFrame(callback),
  cancel: (handle: number) => cancelAnimationFrame(handle),
};

/**
 * `<Mascot>` that moves from one pose to the next: when `pose` changes, the same layers move
 * there over `TRANSITION_MS` while motion may run, and the new pose simply shows otherwise. It
 * is a client component, so its page ships Jack's drawing and every pose; a mascot whose pose
 * does not change is `Mascot` (`@jack/mascot/react`), which ships none of it.
 */
export function LiveMascot({
  pose,
  size = 120,
  title,
  className,
  animate = true,
}: MascotProps): ReactElement {
  const id = useId();
  const scope = motionScope(id);
  const svgRef = useRef<SVGSVGElement>(null);
  // The server, and a page without JavaScript, draw the pose still.
  const [motion, setMotion] = useState<MotionState>("still");
  const [rig, setRig] = useState<PoseRig>(RIGS[pose]);
  const motionRef = useRef(motion);
  const animateRef = useRef(animate);
  const rigRef = useRef(rig);
  const shownPose = useRef(pose);

  useEffect(() => {
    motionRef.current = motion;
  }, [motion]);
  // Before the pose effect below: `motion` only follows `animate` one render later.
  useEffect(() => {
    animateRef.current = animate;
  }, [animate]);
  useEffect(() => {
    rigRef.current = rig;
  }, [rig]);

  useEffect(() => {
    const target = svgRef.current;
    if (!target) return;
    return watchMotion(target, { animate }, setMotion, window);
  }, [animate]);

  // A new pose: the same layers move there while motion may run, or it simply shows.
  useEffect(() => {
    if (shownPose.current === pose) return;
    shownPose.current = pose;
    return transition({
      from: rigRef.current,
      to: RIGS[pose],
      canRun: () => animateRef.current && motionRef.current === "running",
      frames: FRAMES,
      onFrame: setRig,
    });
  }, [pose]);

  return mascotSvg({
    pose,
    size,
    id,
    title,
    className,
    ref: svgRef,
    motion: animate ? { scope, state: motion } : null,
    before: animate ? [createElement("style", { key: "style" }, idleCss(scope, rig))] : [],
    drawing: rigNode(rig),
  });
}
