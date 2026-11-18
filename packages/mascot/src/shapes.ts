import type { Tone } from "./palette.ts";

/**
 * The mascot as data: flat filled shapes in named groups, in a 200 x 200 box (y down). No
 * strokes, no gradients, no images, no text: the web renders it with React (react.tsx) or as an
 * SVG string (render.ts), and the app can map the same tree to react-native-svg.
 */
type Base = { fill: Tone; transform?: string };

export type PathShape = Base & { tag: "path"; d: string };
export type CircleShape = Base & { tag: "circle"; cx: number; cy: number; r: number };
export type EllipseShape = Base & {
  tag: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};
export type RectShape = Base & {
  tag: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
};

export type Shape = PathShape | CircleShape | EllipseShape | RectShape;

/** A named layer (`part`), optionally moved as a whole. */
export type Group = { tag: "g"; part: string; transform?: string; children: MascotNode[] };

export type MascotNode = Shape | Group;

/** The side of the body, as the viewer sees it. */
export type Side = "left" | "right";

export const VIEW_BOX = "0 0 200 200";

export function group(part: string, children: MascotNode[], transform?: string): Group {
  return transform ? { tag: "g", part, transform, children } : { tag: "g", part, children };
}

/** Two decimals at most: smaller files, the same drawing. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Mirrors a shape list across the character's centre line (x = 100). */
export function mirrored(part: string, children: MascotNode[]): Group {
  return group(part, children, "matrix(-1 0 0 1 200 0)");
}

/** The parts of a tree, depth first, in drawing order. */
export function partsOf(node: MascotNode): string[] {
  if (node.tag !== "g") return [];
  return [node.part, ...node.children.flatMap(partsOf)];
}
