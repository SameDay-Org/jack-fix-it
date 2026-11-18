import { group, mirrored, type Group } from "../shapes.ts";

/** The expressions. `thinking` is drawn now for the poses of PR 2. */
export const EXPRESSIONS = ["neutral", "smile", "happy", "thinking"] as const;

export type Expression = (typeof EXPRESSIONS)[number];

/** An open eye, its highlight up and to the right (the same light for both eyes). */
function openEye(cx: number): Group {
  return group("eye", [
    { tag: "ellipse", cx, cy: 66, rx: 3.5, ry: 4.5, fill: "navy900" },
    { tag: "circle", cx: cx + 1.3, cy: 64.3, r: 1.25, fill: "white" },
  ]);
}

/** A closed, laughing eye: a thin upturned arc. */
function happyEye(): Group {
  return group("eye", [
    {
      tag: "path",
      d: "M84.2 67.6C86 62.9 92 62.9 93.8 67.6C91.6 65.6 86.4 65.6 84.2 67.6Z",
      fill: "navy900",
    },
  ]);
}

/** Eyes looking up and to the side, as when weighing a job. */
function thinkingEyes(): Group {
  return group("eyes", [
    { tag: "ellipse", cx: 90.5, cy: 64.8, rx: 3.5, ry: 4.5, fill: "navy900" },
    { tag: "circle", cx: 91.8, cy: 63.1, r: 1.25, fill: "white" },
    { tag: "ellipse", cx: 112.5, cy: 64.8, rx: 3.5, ry: 4.5, fill: "navy900" },
    { tag: "circle", cx: 113.8, cy: 63.1, r: 1.25, fill: "white" },
  ]);
}

function brow(lift = 0, tilt = -7): Group {
  return group("brow", [
    {
      tag: "rect",
      x: 84,
      y: 56.4 - lift,
      width: 10,
      height: 2.4,
      rx: 1.2,
      fill: "navy900",
      transform: `rotate(${tilt} 89 ${57.6 - lift})`,
    },
  ]);
}

function eyes(expression: Expression): Group {
  if (expression === "thinking") return thinkingEyes();
  if (expression === "happy")
    return group("eyes", [happyEye(), mirrored("eye-mirror", [happyEye()])]);
  return group("eyes", [openEye(89), openEye(111)]);
}

function brows(expression: Expression): Group {
  if (expression === "thinking") {
    // One brow up, one level: a question in the face.
    return group("brows", [brow(0, -3), mirrored("brow-mirror", [brow(3.2, -12)])]);
  }
  const lift = expression === "happy" ? 1.6 : 0;
  return group("brows", [brow(lift), mirrored("brow-mirror", [brow(lift)])]);
}

function mouth(expression: Expression): Group {
  switch (expression) {
    case "happy":
      return group("mouth", [
        {
          tag: "path",
          d: "M90.5 79.5H109.5C109 87.6 105.2 91.2 100 91.2S91 87.6 90.5 79.5Z",
          fill: "mouth",
        },
        {
          tag: "path",
          d: "M94.4 87.6C97.6 85.2 102.4 85.2 105.6 87.6C103.8 90.1 102 91 100 91S96.2 90.1 94.4 87.6Z",
          fill: "tongue",
        },
      ]);
    case "smile":
      return group("mouth", [
        {
          tag: "path",
          d: "M91.5 80.2C96.5 85.8 103.5 85.8 108.5 80.2C107.8 85.4 104.2 88.2 100 88.2S92.2 85.4 91.5 80.2Z",
          fill: "mouth",
        },
      ]);
    case "thinking":
      return group("mouth", [
        {
          tag: "path",
          d: "M95.5 83.6C99 82.6 102.6 82.2 106 81.2C105.4 83.4 102.8 85 99.8 85.2C97.8 85.3 96.2 84.7 95.5 83.6Z",
          fill: "mouth",
        },
      ]);
    case "neutral":
      return group("mouth", [
        {
          tag: "path",
          d: "M93.5 81.2C97.6 84.4 102.4 84.4 106.5 81.2C105.6 84.6 103 86.4 100 86.4S94.4 84.6 93.5 81.2Z",
          fill: "mouth",
        },
      ]);
  }
}

/** Eyes, brows and mouth for one expression. */
export function expression(expression: Expression): Group {
  return group(`expression-${expression}`, [
    eyes(expression),
    brows(expression),
    mouth(expression),
  ]);
}
