import { createElement, type ReactElement, type ReactNode, type Ref } from "react";

import type { MascotPose } from "./poses.ts";
import { shapeAttributes } from "./render.ts";
import { type MascotNode, VIEW_BOX } from "./shapes.ts";
import type { MotionState } from "./watch.ts";

/**
 * The props of `<Mascot>` and `<LiveMascot>`: those of the showcase's placeholder component
 * (the public contract: `pose`, `size`, `title`, `className`), plus `animate`. With a `title`
 * the mascot is an image with that accessible name; without one it is decoration, hidden from
 * assistive tech.
 */
export type MascotProps = {
  pose: MascotPose;
  /** Width and height in CSS pixels: every pose is drawn in the same square. */
  size?: number;
  /** The accessible name. Without one the mascot is decoration, hidden from assistive tech. */
  title?: string;
  className?: string;
  /**
   * The idle loops (blink, breathing, a small wave). Never under Reduce Motion; paused while
   * the tab is hidden or the mascot is off screen; without JavaScript the pose stays still.
   * Default true; false keeps it a still picture.
   */
  animate?: boolean;
};

/** A node as a React SVG element (its attribute names are the same in React). */
export function toElement(node: MascotNode, key: number): ReactElement {
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

/**
 * A mascot's `<svg>`: named by its title or hidden from assistive tech, never focusable, its
 * pose on `data-pose` and, when animated, its scope class and motion state. `before` comes
 * between the title and the drawing (the idle CSS, the motion watch).
 */
export function mascotSvg(options: {
  pose: MascotPose;
  size: number;
  id: string;
  title: string | undefined;
  className: string | undefined;
  motion: { scope: string; state: MotionState } | null;
  before: ReactNode[];
  drawing: MascotNode;
  ref?: Ref<SVGSVGElement>;
}): ReactElement {
  const { pose, size, id, title, className, motion } = options;
  const children: ReactNode[] = [];
  if (title) children.push(createElement("title", { key: "title", id }, title));
  children.push(...options.before, toElement(options.drawing, 1));
  return createElement(
    "svg",
    {
      ref: options.ref,
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: VIEW_BOX,
      width: size,
      height: size,
      className: motion ? [motion.scope, className].filter(Boolean).join(" ") : className,
      "data-pose": pose,
      "data-motion": motion?.state,
      ...(title
        ? { role: "img", "aria-labelledby": id }
        : { "aria-hidden": true, focusable: "false" }),
    },
    children,
  );
}
