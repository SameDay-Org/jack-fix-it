import { group, mirrored, type Group } from "../shapes.ts";

/**
 * Jack's head, without the expression (face.ts) and the hat (hat.ts): ears, the face, short
 * dark hair at the temples under the hat, the cheeks and the nose. A big round head on a small
 * body: friendly proportions that stay readable at 32 px.
 */

export const HEAD = { cx: 100, cy: 66, rx: 29, ry: 29 } as const;

function ear(): Group {
  return group("ear", [
    { tag: "ellipse", cx: 71.5, cy: 69, rx: 6, ry: 7.5, fill: "skin" },
    { tag: "ellipse", cx: 72.5, cy: 69, rx: 3, ry: 4.4, fill: "skinShade" },
  ]);
}

/** Short hair at one temple, below the hat's brim. */
function temple(): Group {
  return group("hair-side", [
    {
      tag: "path",
      d: "M72.5 50C71 55.5 71.4 60.5 73.6 64.5L78 63.6C76.6 59.8 76.7 55 78.6 50Z",
      fill: "hair",
    },
  ]);
}

export function ears(): Group {
  return group("ears", [ear(), mirrored("ear-mirror", [ear()])]);
}

export function face(): Group {
  return group("face", [
    { tag: "ellipse", cx: HEAD.cx, cy: HEAD.cy, rx: HEAD.rx, ry: HEAD.ry, fill: "skin" },
  ]);
}

export function hair(): Group {
  return group("hair", [
    temple(),
    mirrored("hair-mirror", [temple()]),
    // A short fringe peeking under the brim.
    {
      tag: "path",
      d: "M80 48.5C85 52.5 92 53.4 98 51.6C103 53.6 111 53 117 49.8L118 48H82Z",
      fill: "hair",
    },
  ]);
}

export function cheeks(): Group {
  return group("cheeks", [
    { tag: "ellipse", cx: 80.5, cy: 77, rx: 4.6, ry: 2.9, fill: "blush" },
    { tag: "ellipse", cx: 119.5, cy: 77, rx: 4.6, ry: 2.9, fill: "blush" },
  ]);
}

export function nose(): Group {
  return group("nose", [{ tag: "ellipse", cx: 100, cy: 74, rx: 3.4, ry: 2.6, fill: "skinShade" }]);
}
