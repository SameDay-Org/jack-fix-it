import { group, mirrored, type Group } from "../shapes.ts";

/**
 * Jack's body: a navy work shirt with a small lime "J" patch (the Jack Fix It mark), a tool
 * belt, grey work trousers and navy boots. No overalls and no checked shirt.
 */

/** Where the arms join the body, as the viewer sees it. */
export const SHOULDER = { left: { x: 75, y: 108 }, right: { x: 125, y: 108 } } as const;

export function neck(): Group {
  return group("neck", [
    { tag: "rect", x: 92.5, y: 88, width: 15, height: 14, rx: 5, fill: "skin" },
    // The chin's shadow on the neck.
    { tag: "ellipse", cx: 100, cy: 92, rx: 7.5, ry: 2.6, fill: "skinShade" },
  ]);
}

/** The "J" patch: the Jack Fix It mark, on the chest. */
export function patch(): Group {
  return group("patch", [
    { tag: "rect", x: 108.5, y: 113, width: 13, height: 13, rx: 3.6, fill: "green500" },
    {
      tag: "path",
      d: "M115.6 116.2H118V120.9C118 123 116.7 124.2 114.8 124.2C113.1 124.2 112 123.2 111.9 121.4L114 121.1C114.1 121.9 114.4 122.3 114.9 122.3C115.4 122.3 115.6 121.9 115.6 121.2Z",
      fill: "navy900",
    },
  ]);
}

export function shirt(): Group {
  return group("shirt", [
    {
      tag: "path",
      d: "M70 112C70 103 77 99 85 99H115C123 99 130 103 130 112L132 146C132 149.5 130 151.5 126.5 151.5H73.5C70 151.5 68 149.5 68 146Z",
      fill: "navy700",
    },
    // The open collar.
    { tag: "path", d: "M92 99H108L100 109.5Z", fill: "skin" },
    { tag: "path", d: "M88.5 99H93L100 109.5L96.4 112.4Z", fill: "navy900" },
    { tag: "path", d: "M111.5 99H107L100 109.5L103.6 112.4Z", fill: "navy900" },
    // A seam down the front.
    { tag: "rect", x: 99.2, y: 111, width: 1.6, height: 30, rx: 0.8, fill: "navy900" },
    patch(),
  ]);
}

export function belt(): Group {
  return group("belt", [
    { tag: "rect", x: 67.5, y: 139, width: 65, height: 9, rx: 2.5, fill: "navy900" },
    // The buckle.
    { tag: "rect", x: 94.5, y: 137.8, width: 11, height: 11.4, rx: 2.6, fill: "green500" },
    { tag: "rect", x: 97.8, y: 141, width: 4.4, height: 5, rx: 1, fill: "navy900" },
    // A pouch with a lime flap on Jack's left.
    { tag: "rect", x: 115.5, y: 144, width: 14, height: 16, rx: 3.5, fill: "navy900" },
    { tag: "rect", x: 115.5, y: 144, width: 14, height: 5.6, rx: 2.8, fill: "green700" },
    // A hammer's handle in the belt on Jack's right.
    { tag: "rect", x: 73, y: 143, width: 4.4, height: 18, rx: 2.2, fill: "metalShade" },
    { tag: "rect", x: 69, y: 140.5, width: 12.4, height: 5, rx: 2, fill: "metal" },
  ]);
}

function leg(): Group {
  return group("leg", [
    { tag: "rect", x: 76.5, y: 146, width: 21.5, height: 39, rx: 6.5, fill: "gray500" },
    // A tan work boot, toes pointing out a little, on a dark sole.
    {
      tag: "path",
      d: "M72 191C72 184.5 76 181.5 81.5 181.5H95.5C97.5 181.5 99 183 99 185V193.5C99 195 98 196 96.5 196H74.5C73 196 72 195 72 193.5Z",
      fill: "boot",
    },
    { tag: "rect", x: 78, y: 183.6, width: 15, height: 2, rx: 1, fill: "sole" },
    { tag: "rect", x: 72, y: 192.6, width: 27, height: 3.4, rx: 1.7, fill: "sole" },
  ]);
}

export function legs(): Group {
  return group("legs", [
    // Where the legs meet, under the belt.
    { tag: "rect", x: 86, y: 146, width: 28, height: 14, rx: 4, fill: "gray500" },
    leg(),
    mirrored("leg-mirror", [leg()]),
  ]);
}
