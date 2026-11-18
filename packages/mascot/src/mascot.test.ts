import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { POSE_BUDGET_BYTES } from "./budget.ts";
import {
  clipboard,
  hat,
  MASCOT_POSES,
  PALETTE,
  partsOf,
  poseNode,
  READY_POSES,
  renderSvg,
  shirt,
  toolbox,
  wrench,
  type MascotNode,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Every value of an attribute in an SVG document. */
function valuesOf(svg: string, attribute: string): string[] {
  return [...svg.matchAll(new RegExp(` ${attribute}="([^"]*)"`, "g"))].map((match) => match[1]!);
}

const svgs = READY_POSES.map((pose) => ({
  pose,
  decorative: renderSvg(poseNode(pose)),
  titled: renderSvg(poseNode(pose), { title: `Jack, ${pose}`, size: 64 }),
}));

describe("the poses", () => {
  it("keep the public contract of the showcase's Mascot component", () => {
    const placeholder = readFileSync(
      join(here, "../../../apps/web/src/features/mascot/mascot.tsx"),
      "utf8",
    );
    const listed = /MASCOT_POSES = \[([^\]]*)\]/.exec(placeholder)?.[1] ?? "";
    expect([...listed.matchAll(/"([a-z]+)"/g)].map((match) => match[1])).toEqual([...MASCOT_POSES]);
    expect(READY_POSES.every((pose) => MASCOT_POSES.includes(pose))).toBe(true);
  });

  it.each(READY_POSES)("%s is built from the named layers, back to front", (pose) => {
    const parts = partsOf(poseNode(pose));
    const top = (poseNode(pose).children as { part?: string }[]).map((child) => child.part);
    expect(top).toEqual(["arms-back", "legs", "torso", "head", "arms-front"]);
    for (const part of ["ears", "face", "hair", "cheeks", "nose", "hat", "neck", "shirt"]) {
      expect(parts).toContain(part);
    }
    expect(parts).toEqual(expect.arrayContaining(["patch", "belt", "arm-left", "arm-right"]));
    expect(parts).toMatchSnapshot();
  });

  it("each draw the expression, the gloves and the props of their moment", () => {
    const parts = (pose: (typeof READY_POSES)[number]) => partsOf(poseNode(pose));
    expect(parts("wave")).toEqual(
      expect.arrayContaining(["expression-smile", "glove-open", "glove-fist"]),
    );
    expect(parts("celebrate")).toContain("expression-happy");
    expect(parts("celebrate").filter((part) => part === "glove-fist")).toHaveLength(2);
    expect(parts("tools")).toEqual(expect.arrayContaining(["prop-wrench", "prop-toolbox"]));
  });

  it("are compositions of the same parts, not copies", () => {
    const hatSvg = renderSvg(hat()).replace(/^<svg[^>]*>|<\/svg>$/g, "");
    const shirtSvg = renderSvg(shirt()).replace(/^<svg[^>]*>|<\/svg>$/g, "");
    for (const { decorative } of svgs) {
      expect(decorative).toContain(hatSvg);
      expect(decorative).toContain(shirtSvg);
    }
  });
});

describe("the SVG output", () => {
  it.each(svgs)(
    "$pose holds only plain shapes: no link, script, foreign content or image",
    ({ decorative, titled }) => {
      const allowed = new Set(["svg", "title", "g", "path", "circle", "ellipse", "rect"]);
      for (const svg of [decorative, titled]) {
        const tags = [...svg.matchAll(/<([a-zA-Z]+)/g)].map((match) => match[1]!);
        expect(tags.filter((tag) => !allowed.has(tag))).toEqual([]);
        expect(svg).not.toMatch(/href|<script|<foreignObject|<image|url\(|style=| on[a-z]+=/i);
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

  it.each(svgs)("$pose stays under its size budget", ({ decorative, titled }) => {
    expect(Buffer.byteLength(decorative)).toBeLessThan(POSE_BUDGET_BYTES);
    expect(Buffer.byteLength(titled)).toBeLessThan(POSE_BUDGET_BYTES);
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

  it("writes the title as text", () => {
    const svg = renderSvg(poseNode("tools"), {
      title: `<img src=x onerror="alert(1)"> & co`,
      titleId: `"x`,
    });
    expect(svg).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; co");
    expect(svg).toContain('id="&quot;x"');
    expect(svg).not.toContain("<img");
  });
});

describe("the props", () => {
  it.each<[string, () => MascotNode]>([
    ["wrench", wrench],
    ["toolbox", toolbox],
    ["clipboard", clipboard],
  ])("the %s is a named part in the same style", (name, prop) => {
    const svg = renderSvg(prop());
    expect(svg).toContain(`data-part="prop-${name}"`);
    expect(svg).not.toMatch(/stroke|href|<image/);
  });
});
