"use client";

import {
  createElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { idleCss, motionScope, transition, watchMotion, type MotionState } from "./motion.ts";
import type { MascotPose } from "./poses.ts";
import { shapeAttributes } from "./render.ts";
import { RIGS, rigNode, type PoseRig } from "./rig.ts";
import { type MascotNode, VIEW_BOX } from "./shapes.ts";

/**
 * `<Mascot>` for the web: the props of the showcase's placeholder component (the public
 * contract: `pose`, `size`, `title`, `className`), plus `animate`. With a `title` the mascot is
 * an image with that accessible name; without one it is decoration, hidden from assistive tech.
 */
export type MascotProps = {
  pose: MascotPose;
  /** Width and height in CSS pixels: every pose is drawn in the same square. */
  size?: number;
  /** The accessible name. Without one the mascot is decoration, hidden from assistive tech. */
  title?: string;
  className?: string;
  /**
   * The idle loops (blink, breathing, a small wave) and the move to a new `pose`. Never under
   * Reduce Motion; paused while the tab is hidden or the mascot is off screen; without
   * JavaScript the pose stays still. Default true; false keeps it a still picture.
   */
  animate?: boolean;
};

/** A node as a React SVG element (its attribute names are the same in React). */
function toElement(node: MascotNode, key: number): ReactElement {
  if (node.tag === "g") {
    return createElement(
      "g",
      { key, "data-part": node.part, transform: node.transform },
      node.children.map(toElement),
    );
  }
  const props: Record<string, string | number> = { key };
  for (const [name, value] of shapeAttributes(node)) props[name] = value;
  return createElement(node.tag, props);
}

const FRAMES = {
  request: (callback: (time: number) => void) => requestAnimationFrame(callback),
  cancel: (handle: number) => cancelAnimationFrame(handle),
};

export function Mascot({
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
  const rigRef = useRef(rig);
  const shownPose = useRef(pose);

  useEffect(() => {
    motionRef.current = motion;
  }, [motion]);
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
      canRun: () => motionRef.current === "running",
      frames: FRAMES,
      onFrame: setRig,
    });
  }, [pose]);

  const children: ReactNode[] = [];
  if (title) children.push(createElement("title", { key: "title", id }, title));
  if (animate) children.push(createElement("style", { key: "style" }, idleCss(scope, rig)));
  children.push(toElement(rigNode(rig), 1));
  return createElement(
    "svg",
    {
      ref: svgRef,
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: VIEW_BOX,
      width: size,
      height: size,
      className: animate ? [scope, className].filter(Boolean).join(" ") : className,
      "data-motion": animate ? motion : undefined,
      ...(title
        ? { role: "img", "aria-labelledby": id }
        : { "aria-hidden": true, focusable: "false" }),
    },
    children,
  );
}
