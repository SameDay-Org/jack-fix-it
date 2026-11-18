import { group, type Group } from "../shapes.ts";

/**
 * The lime hard hat: a rounded dome with a darker centre ridge and a gloss, over a flat brim.
 * Lime, never yellow: the brand's colour, and nothing like a classic yellow builder's helmet.
 */
export function hat(): Group {
  return group("hat", [
    // The dome.
    {
      tag: "path",
      d: "M69 48C69 29.5 82.5 17 100 17S131 29.5 131 48Z",
      fill: "green500",
    },
    // The ridge down its middle.
    { tag: "path", d: "M95.5 18.2C98.5 17.4 101.5 17.4 104.5 18.2V47H95.5Z", fill: "green700" },
    // The gloss on its left.
    {
      tag: "path",
      d: "M77.5 41C77.5 33 81.5 26.5 88.5 22.4C84.8 27.2 82.4 33.4 81.8 41Z",
      fill: "white",
    },
    // The brim, with its darker underside.
    { tag: "rect", x: 62, y: 45, width: 76, height: 8, rx: 4, fill: "green500" },
    { tag: "rect", x: 65, y: 50.4, width: 70, height: 2.6, rx: 1.3, fill: "green700" },
  ]);
}
