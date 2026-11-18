/**
 * The mascot's gallery page (#404): every part, the six poses at 32, 64, 128 and 256 px on
 * white, light gray and navy (static SVG inline), then the motion: the idle loops, the pose
 * changes, a Reduce Motion toggle and the pause off screen. The motion section needs the module
 * script the preview serves (`/scripts/demo.ts`); everything above it is plain HTML.
 */
import {
  arm,
  belt,
  cheeks,
  clipboard,
  ears,
  expression,
  EXPRESSIONS,
  face,
  group,
  hair,
  hat,
  legs,
  neck,
  nose,
  PALETTE,
  patch,
  poseNode,
  question,
  READY_POSES,
  renderSvg,
  shirt,
  toolbox,
  wrench,
  type MascotNode,
} from "../src/index.ts";

export const SIZES = [32, 64, 128, 256] as const;

export const BACKGROUNDS = [
  { id: "white", label: "White", color: PALETTE.white, text: PALETTE.navy900 },
  { id: "gray", label: "Light gray", color: PALETTE.gray50, text: PALETTE.navy900 },
  { id: "navy", label: "Navy", color: PALETTE.navy900, text: PALETTE.white },
] as const;

/** A part drawn alone, close up: `crop` is the part's area of the 200 x 200 box. */
function partTile(name: string, node: MascotNode, crop: string): string {
  return `<figure><div class="tile">${renderSvg(node, { size: 112, title: name, titleId: `part-${name}`, viewBox: crop })}</div><figcaption>${name}</figcaption></figure>`;
}

/** The props are drawn around their grip point (0, 0). */
const PROP_CROP = "-30 -40 60 70";

export function galleryHtml(): string {
  const parts: [string, MascotNode, string][] = [
    [
      "head",
      group("head", [ears(), face(), hair(), cheeks(), nose(), expression("smile")]),
      "60 30 80 70",
    ],
    ["hat", hat(), "58 12 84 46"],
    ...EXPRESSIONS.map(
      (name) =>
        [
          `face: ${name}`,
          group("face", [face(), cheeks(), nose(), expression(name)]),
          "70 36 60 60",
        ] as [string, MascotNode, string],
    ),
    ["shirt", group("torso", [neck(), shirt()]), "60 84 80 72"],
    ["patch", patch(), "106 111 18 18"],
    ["belt", belt(), "62 130 76 36"],
    ["legs", legs(), "62 142 76 58"],
    [
      "arm (open glove)",
      arm("right", { upper: 125, lower: 160, glove: "open", layer: "back" }),
      "112 46 56 70",
    ],
    [
      "arm (fist)",
      arm("left", { upper: 14, lower: 8, glove: "fist", layer: "back" }),
      "42 96 50 76",
    ],
    [
      "arm (pointing)",
      arm("right", { upper: 74, lower: 88, glove: "point", layer: "back" }),
      "118 88 82 46",
    ],
    ["wrench", wrench(), PROP_CROP],
    ["toolbox", toolbox(), PROP_CROP],
    ["clipboard", clipboard(), PROP_CROP],
    ["question mark", question(), "-20 -24 40 40"],
  ];
  const poses = BACKGROUNDS.map(
    (bg) => `
    <section class="poses" id="poses-${bg.id}" style="background:${bg.color};color:${bg.text}">
      <h2>Poses on ${bg.label.toLowerCase()}</h2>
      ${READY_POSES.map(
        (pose) => `
        <div class="row">
          <h3>${pose}</h3>
          ${SIZES.map(
            (size) =>
              `<figure>${renderSvg(poseNode(pose), { size, title: `Jack, ${pose}`, titleId: `${bg.id}-${pose}-${size}` })}<figcaption>${size} px</figcaption></figure>`,
          ).join("")}
        </div>`,
      ).join("")}
    </section>`,
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Jack, the mascot: gallery</title>
<style>
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; color: ${PALETTE.navy900}; background: ${PALETTE.white}; }
  header, .parts { padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { margin: 0 0 16px; font-size: 18px; }
  h3 { width: 96px; margin: 0; font-size: 14px; text-transform: capitalize; }
  .grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .tile { width: 112px; height: 112px; background: ${PALETTE.gray50}; border-radius: 12px; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  figcaption { font-size: 12px; opacity: 0.8; }
  .poses { padding: 24px; }
  .row { display: flex; align-items: flex-end; gap: 28px; margin-bottom: 24px; }
  .motion { padding: 24px; background: ${PALETTE.gray50}; }
  .demos { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
  .demo { background: ${PALETTE.white}; border-radius: 16px; padding: 16px; width: 288px; }
  .stage { width: 256px; height: 256px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button { font: inherit; padding: 6px 12px; border-radius: 999px; border: 1px solid ${PALETTE.navy700}; background: ${PALETTE.white}; color: ${PALETTE.navy900}; cursor: pointer; }
  button[aria-pressed="true"] { background: ${PALETTE.green500}; border-color: ${PALETTE.green700}; }
  output { display: block; margin-top: 8px; font-weight: 600; }
  .spacer { height: 1400px; display: flex; align-items: flex-end; justify-content: center; color: ${PALETTE.gray500}; }
</style>
</head>
<body>
<header>
  <h1>Jack, the Jack Fix It mascot</h1>
  <p>#404: the parts, the six poses and the motion. Local preview, not part of the site.</p>
</header>
<section class="parts" id="parts">
  <h2>Parts</h2>
  <div class="grid">${parts.map(([name, node, crop]) => partTile(name, node, crop)).join("")}</div>
</section>
${poses}
<section class="motion" id="motion">
  <h2>Motion</h2>
  <p>
    <label><input type="checkbox" id="reduce"> Reduce Motion (as if the reader asked for it)</label>
    <span id="reduce-system"></span>
  </p>
  <div class="demos">
    <div class="demo" id="demo-idle">
      <h3>Idle loops</h3>
      <div class="stage" data-demo="idle" data-pose="wave"></div>
      <output data-status-for="idle">still</output>
    </div>
    <div class="demo" id="demo-transition">
      <h3>Pose changes</h3>
      <div class="stage" data-demo="transition" data-pose="wave"></div>
      <div class="controls">${READY_POSES.map((pose) => `<button type="button" data-to="${pose}" aria-pressed="${pose === "wave"}">${pose}</button>`).join("")}</div>
      <output data-status-for="transition">still</output>
    </div>
  </div>
  <div class="spacer"><p>Scroll on: the mascot below is paused until it is on screen.</p></div>
  <div class="demo" id="demo-offscreen">
    <h3>Off screen until here</h3>
    <div class="stage" data-demo="offscreen" data-pose="celebrate"></div>
    <output data-status-for="offscreen">still</output>
  </div>
</section>
<script type="module" src="/scripts/demo.ts"></script>
</body>
</html>
`;
}
