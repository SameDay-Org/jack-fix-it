import { createElement, useId, type ReactElement, type ReactNode } from "react";

import { type ReadyPose, poseNode } from "./poses.ts";
import { shapeAttributes } from "./render.ts";
import { type MascotNode, VIEW_BOX } from "./shapes.ts";

/**
 * `<Mascot>` for the web: the same props as the showcase's placeholder component (the public
 * contract: `pose`, `size`, `title`, `className`). With a `title` the mascot is an image with
 * that accessible name; without one it is decoration, hidden from assistive tech.
 */
export type MascotProps = {
  pose: ReadyPose;
  /** Width and height in CSS pixels: every pose is drawn in the same square. */
  size?: number;
  /** The accessible name. Without one the mascot is decoration, hidden from assistive tech. */
  title?: string;
  className?: string;
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

export function Mascot({ pose, size = 120, title, className }: MascotProps): ReactElement {
  const titleId = useId();
  const children: ReactNode[] = [];
  if (title) children.push(createElement("title", { key: "title", id: titleId }, title));
  children.push(toElement(poseNode(pose), 1));
  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: VIEW_BOX,
      width: size,
      height: size,
      className,
      ...(title
        ? { role: "img", "aria-labelledby": titleId }
        : { "aria-hidden": true, focusable: "false" }),
    },
    children,
  );
}
