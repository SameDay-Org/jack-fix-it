import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ANIMATED_POSE_BUDGET_BYTES, POSE_BUDGET_BYTES } from "./budget.ts";
import {
  clipboard,
  hat,
  idleCss,
  MASCOT_POSES,
  PALETTE,
  partsOf,
  poseNode,
  question,
  READY_POSES,
  renderSvg,
  RIGS,
  shirt,
  toolbox,
  wrench,
  type MascotNode,
  type MascotPose,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Every value of an attribute in an SVG document. */
function valuesOf(svg: string, attribute: string): string[] {
  return [...svg.matchAll(new RegExp(` ${attribute}="([^"]*)"`, "g"))].map((match) => match[1]!);
}

function animated(pose: MascotPose): string {
  const scope = `jack-${pose}`;
  return renderSvg(poseNode(pose), {
    title: `Jack, ${pose}`,
    motion: { scope, state: "running", css: idleCss(scope, RIGS[pose]) },
  });
}

const svgs = READY_POSES.map((pose) => ({
  pose,
  decorative: renderSvg(poseNode(pose)),
  titled: renderSvg(poseNode(pose), { title: `Jack, ${pose}`, size: 64 }),
  animated: animated(pose),
}));

const children = (node: MascotNode) =>
  node.tag === "g"
    ? node.children.map((child) => (child.tag === "g" ? child.part : child.tag))
    : [];

describe("the poses", () => {
  it("are the six of the public contract the pages ask for, all drawn", () => {
    expect([...MASCOT_POSES]).toEqual(["wave", "point", "celebrate", "peek", "thinking", "tools"]);
    expect([...READY_POSES]).toEqual([...MASCOT_POSES]);
  });

  it.each(READY_POSES)("%s is built from the named layers, back to front", (pose) => {
    const root = poseNode(pose);
    expect(children(root)).toEqual(pose === "thinking" ? ["lean", "thought"] : ["lean"]);
    const lean = root.children[0]!;
    expect(children(lean)).toEqual(["legs", "upper"]);
    const upper = lean.tag === "g" ? lean.children[1]! : lean;
    expect(children(upper)).toEqual(["arms-back", "torso", "head", "arms-front"]);
    const parts = partsOf(root);
    for (const part of ["ears", "face", "hair", "cheeks", "nose", "hat", "neck", "shirt"]) {
      expect(parts).toContain(part);
    }
    expect(parts).toEqual(
      expect.arrayContaining([
        "patch",
        "belt",
        "arm-left",
        "arm-right",
        "forearm-left",
        "forearm-right",
      ]),
    );
    expect(parts).toMatchSnapshot();
  });

  it("each draw the expression, the gloves and the props of their moment", () => {
    const parts = (pose: MascotPose) => partsOf(poseNode(pose));
    expect(parts("wave")).toEqual(
      expect.arrayContaining(["expression-smile", "glove-open", "glove-fist"]),
    );
    expect(parts("point")).toEqual(expect.arrayContaining(["expression-smile", "glove-point"]));
    expect(parts("celebrate")).toContain("expression-happy");
    expect(parts("celebrate").filter((part) => part === "glove-fist")).toHaveLength(2);
    expect(parts("peek")).toEqual(expect.arrayContaining(["glove-open"]));
    expect(parts("thinking")).toEqual(
      expect.arrayContaining(["expression-thinking", "prop-question"]),
    );
    expect(parts("tools")).toEqual(expect.arrayContaining(["prop-wrench", "prop-toolbox"]));
  });

  it("peek leans in from the right edge: the body is moved, the box cuts the rest", () => {
    const lean = poseNode("peek").children[0]!;
    expect(lean.tag === "g" && lean.transform).toMatch(/^translate\(9\d /);
    for (const pose of READY_POSES.filter((name) => name !== "peek")) {
      const upright = poseNode(pose).children[0]!;
      expect(upright.tag === "g" && upright.transform).toBeFalsy();
    }
  });

  it("are compositions of the same parts, not copies", () => {
    const inner = (svg: string) => svg.replace(/^<svg[^>]*>|<\/svg>$/g, "");
    const hatSvg = inner(renderSvg(hat()));
    const shirtSvg = inner(renderSvg(shirt()));
    for (const { decorative } of svgs) {
      expect(decorative).toContain(hatSvg);
      expect(decorative).toContain(shirtSvg);
    }
  });
});

describe("the SVG output", () => {
  const STILL_TAGS = new Set(["svg", "title", "g", "path", "circle", "ellipse", "rect"]);

  it.each(svgs)(
    "$pose holds only plain shapes: no link, script, foreign content or image",
    ({ decorative, titled, animated: moving }) => {
      for (const [svg, allowed] of [
        [decorative, STILL_TAGS],
        [titled, STILL_TAGS],
        [moving, new Set([...STILL_TAGS, "style"])],
      ] as const) {
        const tags = [...svg.matchAll(/<([a-zA-Z]+)/g)].map((match) => match[1]!);
        expect(tags.filter((tag) => !allowed.has(tag))).toEqual([]);
        expect(svg).not.toMatch(
          /href|<script|<foreignObject|<image|url\(|@import|style=| on[a-z]+=/i,
        );
      }
    },
  );

  it.each(svgs)(
    "$pose draws flat fills from the palette only, with no stroke",
    ({ decorative }) => {
      const tones = new Set<string>(Object.values(PALETTE));
      const fills = valuesOf(decorative, "fill");
      expect(fills.length).toBeGreaterThan(40);
      expect(fills.filter((fill) => !tones.has(fill))).toEqual([]);
      expect(decorative).not.toMatch(/stroke/);
    },
  );

  it("names no colour outside the palette module", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
            ? [join(dir, entry.name)]
            : [],
      );
    const offenders = files(here)
      .filter((file) => !file.endsWith("palette.ts"))
      .filter((file) =>
        /["'`]#[0-9a-f]{3,8}["'`]|rgba?\(|hsla?\(/i.test(readFileSync(file, "utf8")),
      );
    expect(offenders).toEqual([]);
  });

  it.each(svgs)("$pose stays under its size budgets, still and animated", (svg) => {
    expect(Buffer.byteLength(svg.decorative)).toBeLessThan(POSE_BUDGET_BYTES);
    expect(Buffer.byteLength(svg.titled)).toBeLessThan(POSE_BUDGET_BYTES);
    expect(Buffer.byteLength(svg.animated)).toBeLessThan(ANIMATED_POSE_BUDGET_BYTES);
  });

  it("is an image with its name, or decoration hidden from assistive tech", () => {
    const titled = renderSvg(poseNode("wave"), {
      title: "Jack waves hello",
      titleId: "t1",
      size: 48,
    });
    expect(titled).toMatch(/^<svg [^>]*role="img" aria-labelledby="t1"/);
    expect(titled).toContain('<title id="t1">Jack waves hello</title>');
    expect(titled).toMatch(/width="48" height="48"/);
    expect(titled).not.toContain("aria-hidden");

    const decorative = renderSvg(poseNode("wave"));
    expect(decorative).toMatch(/^<svg [^>]*aria-hidden="true" focusable="false"/);
    expect(decorative).not.toMatch(/role=|<title/);
    expect(decorative).toContain('viewBox="0 0 200 200"');
    // A close-up crop, as the gallery's parts sheet uses.
    expect(renderSvg(hat(), { viewBox: "58 12 84 46" })).toContain('viewBox="58 12 84 46"');
  });

  it("writes the title as text, and refuses CSS that holds markup", () => {
    const svg = renderSvg(poseNode("tools"), {
      title: `<img src=x onerror="alert(1)"> & co`,
      titleId: `"x`,
    });
    expect(svg).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; co");
    expect(svg).toContain('id="&quot;x"');
    expect(svg).not.toContain("<img");
    expect(() =>
      renderSvg(poseNode("wave"), {
        motion: { scope: "s", state: "still", css: "</style><script>" },
      }),
    ).toThrow();
  });

  it("animated output carries its scope, its state and its idle CSS before the drawing", () => {
    const svg = animated("wave");
    expect(svg).toMatch(/^<svg [^>]*class="jack-wave" data-motion="running"/);
    expect(svg).toMatch(
      /<\/title><style>@media \(prefers-reduced-motion:no-preference\)\{.*<\/style><g data-part="mascot">/,
    );
  });
});

describe("the props", () => {
  it.each<[string, () => MascotNode]>([
    ["wrench", wrench],
    ["toolbox", toolbox],
    ["clipboard", clipboard],
    ["question", question],
  ])("the %s is a named part in the same style", (name, prop) => {
    const svg = renderSvg(prop());
    expect(svg).toContain(`data-part="prop-${name}"`);
    expect(svg).not.toMatch(/stroke|href|<image/);
  });
});
