import { PALETTE } from "./palette.ts";
import { type MascotNode, type Shape, VIEW_BOX } from "./shapes.ts";

/** What a rendered mascot says about itself. */
export type SvgOptions = {
  /** Width and height in CSS pixels; without it the SVG fills its box. */
  size?: number;
  /** The accessible name. Without one the mascot is decoration, hidden from assistive tech. */
  title?: string;
  /** The id of the `<title>`, unique on the page (for `aria-labelledby`). */
  titleId?: string;
  /** A crop of the 200 x 200 box, to show one part close up (the gallery's parts sheet). */
  viewBox?: string;
  /** Animated output (motion.ts): the root's class, its motion state and its idle CSS. */
  motion?: { scope: string; state: "still" | "paused" | "running"; css: string };
};

/** The idle CSS is generated from numbers and names; it never holds markup. */
function styleElement(css: string): string {
  if (css.includes("<")) throw new Error("CSS with markup in it");
  return `<style>${css}</style>`;
}

/** A shape's attributes, in the order they are written, with its tone resolved. */
export function shapeAttributes(shape: Shape): [string, string | number][] {
  const own: [string, string | number | undefined][] =
    shape.tag === "path"
      ? [["d", shape.d]]
      : shape.tag === "circle"
        ? [
            ["cx", shape.cx],
            ["cy", shape.cy],
            ["r", shape.r],
          ]
        : shape.tag === "ellipse"
          ? [
              ["cx", shape.cx],
              ["cy", shape.cy],
              ["rx", shape.rx],
              ["ry", shape.ry],
            ]
          : [
              ["x", shape.x],
              ["y", shape.y],
              ["width", shape.width],
              ["height", shape.height],
              ["rx", shape.rx],
            ];
  return [...own, ["fill", PALETTE[shape.fill]], ["transform", shape.transform]].filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined,
  );
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function attributes(pairs: [string, string | number][]): string {
  return pairs.map(([name, value]) => ` ${name}="${escape(String(value))}"`).join("");
}

function nodeToSvg(node: MascotNode): string {
  if (node.tag === "g") {
    const own: [string, string][] = [["data-part", node.part]];
    if (node.transform) own.push(["transform", node.transform]);
    return `<g${attributes(own)}>${node.children.map(nodeToSvg).join("")}</g>`;
  }
  return `<${node.tag}${attributes(shapeAttributes(node))}/>`;
}

/** The mascot as a standalone SVG document: no script, no link, no image, no text but the title. */
export function renderSvg(node: MascotNode, options: SvgOptions = {}): string {
  const { size, title } = options;
  const root: [string, string | number][] = [
    ["xmlns", "http://www.w3.org/2000/svg"],
    ["viewBox", options.viewBox ?? VIEW_BOX],
  ];
  if (size !== undefined) root.push(["width", size], ["height", size]);
  const { motion } = options;
  if (motion) root.push(["class", motion.scope], ["data-motion", motion.state]);
  const style = motion ? styleElement(motion.css) : "";
  if (title) {
    const id = options.titleId ?? "jack-mascot-title";
    root.push(["role", "img"], ["aria-labelledby", id]);
    return `<svg${attributes(root)}><title id="${escape(id)}">${escape(title)}</title>${style}${nodeToSvg(node)}</svg>`;
  }
  root.push(["aria-hidden", "true"], ["focusable", "false"]);
  return `<svg${attributes(root)}>${style}${nodeToSvg(node)}</svg>`;
}
