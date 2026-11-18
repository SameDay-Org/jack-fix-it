import { createElement, useId, type ReactElement } from "react";

import { idleCss, motionScope } from "./motion.ts";
import { MotionWatch } from "./react-motion.ts";
import { mascotSvg, type MascotProps } from "./react-svg.ts";
import { RIGS, rigNode } from "./rig.ts";

export type { MascotProps } from "./react-svg.ts";

/**
 * `<Mascot>` for the web, drawn where it is rendered: in a Server Component the page ships none
 * of Jack's drawing or poses. With `animate` (the default) its idle loops are CSS that apply
 * only while the SVG says `data-motion="running"`, which `MotionWatch`, its one client piece,
 * sets in the browser (`react-motion.ts`). A new `pose` shows at once; to move from one pose
 * to another, use `LiveMascot` (`@jack/mascot/react-live`).
 */
export function Mascot({
  pose,
  size = 120,
  title,
  className,
  animate = true,
}: MascotProps): ReactElement {
  const id = useId();
  const scope = motionScope(id);
  const rig = RIGS[pose];
  return mascotSvg({
    pose,
    size,
    id,
    title,
    className,
    motion: animate ? { scope, state: "still" } : null,
    before: animate
      ? [
          createElement("style", { key: "style" }, idleCss(scope, rig)),
          createElement(MotionWatch, { key: "watch" }),
        ]
      : [],
    drawing: rigNode(rig),
  });
}
