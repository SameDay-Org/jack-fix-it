"use client";

import { createElement, useEffect, useRef, type ReactElement } from "react";

import { watchMotion } from "./watch.ts";

/**
 * The one piece of a server-drawn `<Mascot>` that runs in the browser: an empty group inside
 * its `<svg>` that sets the SVG's `data-motion` to `running` while motion is allowed, the tab is
 * shown and Jack is on screen, and to `paused` or `still` otherwise (`watch.ts`). Until it runs,
 * and without JavaScript, the SVG stays `still`. It imports only `watch.ts`, so a page ships
 * none of Jack's drawing.
 */
export function MotionWatch(): ReactElement {
  const ref = useRef<SVGGElement>(null);
  useEffect(() => {
    const svg = ref.current?.ownerSVGElement;
    if (!svg) return;
    return watchMotion(
      svg,
      { animate: true },
      (state) => svg.setAttribute("data-motion", state),
      window,
    );
  }, []);
  return createElement("g", { ref, "data-motion-watch": "" });
}
