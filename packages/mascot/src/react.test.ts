import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { idleCss } from "./motion.ts";
import { MASCOT_POSES, poseNode } from "./poses.ts";
import { LiveMascot } from "./react-live.ts";
import { Mascot } from "./react.ts";
import { renderSvg } from "./render.ts";
import { RIGS } from "./rig.ts";

const here = dirname(fileURLToPath(import.meta.url));

type Component = typeof Mascot;

function markup(component: Component, props: Parameters<Component>[0]): string {
  return renderToStaticMarkup(createElement(component, props));
}

/**
 * The drawing without the root element, the title, the idle CSS and the motion watch: what
 * both renderers must agree on. React closes an empty SVG element with its end tag
 * (`<rect …></rect>`), the string renderer with `/>`.
 */
function drawing(svg: string): string {
  return svg
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "")
    .replace(/<title[^>]*>.*?<\/title>/, "")
    .replace(/<style>.*?<\/style>/, "")
    .replace(/<g data-motion-watch=""><\/g>/, "")
    .replace(/<(path|circle|ellipse|rect)([^<>]*)><\/\1>/g, "<$1$2/>");
}

describe.each([
  ["<Mascot>", Mascot],
  ["<LiveMascot>", LiveMascot],
] as const)("%s for the web", (_, component) => {
  it("is an image named by its title", () => {
    const html = markup(component, { pose: "wave", title: "Jack waves hello" });
    const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(/^<svg [^>]*role="img"/);
    expect(id).toBeTruthy();
    expect(html).toContain(`<title id="${id}">Jack waves hello</title>`);
    expect(html).not.toContain("aria-hidden");
  });

  it("is decoration, hidden from assistive tech, without a title", () => {
    const html = markup(component, { pose: "celebrate" });
    expect(html).toMatch(/aria-hidden="true"/);
    expect(html).toMatch(/focusable="false"/);
    expect(html).not.toMatch(/role=|<title/);
  });

  it("takes its size and class like the showcase's component, and names its pose", () => {
    expect(markup(component, { pose: "tools" })).toMatch(/width="120" height="120"/);
    const html = markup(component, { pose: "tools", size: 48, className: "mascot shadow" });
    expect(html).toMatch(/width="48" height="48"/);
    expect(html).toMatch(/class="jack-[A-Za-z0-9_-]+ mascot shadow"/);
    expect(html).toContain('viewBox="0 0 200 200"');
    expect(html).toContain('data-pose="tools"');
    expect(markup(component, { pose: "tools", className: "mascot", animate: false })).toContain(
      'class="mascot"',
    );
  });

  it("is drawn still on the server and without JavaScript, its idle CSS waiting for a script", () => {
    const html = markup(component, { pose: "wave" });
    const scope = /class="(jack-[A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? "";
    expect(html).toMatch(/data-motion="still"/);
    // The CSS is written as is (no entity in it), and only applies while running.
    expect(html).toContain(`<style>${idleCss(scope, RIGS.wave)}</style>`);
    expect(html).not.toContain('data-motion="running"');
  });

  it("is a still picture with animate={false}: no CSS, no motion state, no script", () => {
    const html = markup(component, { pose: "wave", animate: false });
    expect(html).not.toMatch(/<style|data-motion/);
  });

  it.each(MASCOT_POSES)("draws %s exactly as the SVG renderer does", (pose) => {
    expect(drawing(markup(component, { pose }))).toBe(drawing(renderSvg(poseNode(pose))));
  });
});

describe("what a page ships", () => {
  const source = (file: string) => readFileSync(join(here, file), "utf8");
  const imports = (file: string) =>
    [...source(file).matchAll(/^import [^;]*? from "([^"]+)";$/gms)].map((match) => match[1]);

  it("draws <Mascot> where it is rendered: not a client module, so a Server Component keeps the drawing", () => {
    expect(source("react.ts")).not.toMatch(/^["']use client["']/);
    expect(source("react-motion.ts")).toMatch(/^"use client";/);
    expect(source("react-live.ts")).toMatch(/^"use client";/);
  });

  it("sends only the motion rules to the browser for an animated <Mascot>", () => {
    expect(imports("react-motion.ts")).toEqual(["react", "./watch.ts"]);
    expect(imports("watch.ts")).toEqual([]);
  });

  it("adds the motion watch inside the SVG only when animated", () => {
    expect(markup(Mascot, { pose: "thinking" })).toMatch(
      /^<svg [^>]*data-motion="still"[^>]*>.*<g data-motion-watch=""><\/g>/,
    );
    expect(markup(Mascot, { pose: "thinking", animate: false })).not.toContain("data-motion");
    expect(markup(LiveMascot, { pose: "thinking" })).not.toContain("data-motion-watch");
  });
});
