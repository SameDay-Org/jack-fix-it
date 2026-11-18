import { describe, expect, it } from "vitest";

import { READY_POSES } from "../src/index.ts";
import { BACKGROUNDS, galleryHtml, SIZES } from "./gallery.ts";
import { HEADERS, respond } from "./serve.ts";

describe("the local gallery", () => {
  const html = galleryHtml();

  it("shows the six poses at every size on white, light gray and navy", () => {
    for (const bg of BACKGROUNDS) expect(html).toContain(`id="poses-${bg.id}"`);
    const poses = [...html.matchAll(/<title id="(white|gray|navy)-([a-z]+)-(\d+)">/g)];
    expect(READY_POSES).toHaveLength(6);
    expect(poses).toHaveLength(BACKGROUNDS.length * READY_POSES.length * SIZES.length);
    expect(new Set(poses.map((match) => match[2]))).toEqual(new Set(READY_POSES));
  });

  it("has the motion section: idle loops, every pose change, a Reduce Motion toggle, an off-screen mascot", () => {
    for (const demo of ["idle", "transition", "offscreen"]) {
      expect(html).toContain(`data-demo="${demo}"`);
      expect(html).toContain(`data-status-for="${demo}"`);
    }
    for (const pose of READY_POSES) expect(html).toContain(`data-to="${pose}"`);
    expect(html).toContain('<input type="checkbox" id="reduce">');
  });

  it("is never indexed, links nowhere and runs only the package's own module", () => {
    expect(html).toContain('<meta name="robots" content="noindex">');
    // The inline SVGs' namespace is a name, not a link.
    expect(html.replaceAll('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(
      /href=|https?:\/\//,
    );
    expect([...html.matchAll(/<script[^>]*>/g)].map((match) => match[0])).toEqual([
      '<script type="module" src="/scripts/demo.ts">',
    ]);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
  });
});

describe("the preview server", () => {
  it("answers the gallery, under a policy that allows only its own scripts", () => {
    const page = respond("/");
    expect(page).toMatchObject({ status: 200, type: "text/html; charset=utf-8" });
    expect(HEADERS["Content-Security-Policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'",
    );
  });

  it("serves the package's modules as JavaScript, their types stripped", () => {
    const module = respond("/src/watch.ts");
    expect(module).toMatchObject({ status: 200, type: "text/javascript; charset=utf-8" });
    expect(module.body).toContain("export function motionState(");
    expect(module.body).not.toMatch(/: MotionInputs\)|export type MotionState/);
    expect(respond("/src/motion.ts").status).toBe(200);
    expect(respond("/src/parts/arms.ts").status).toBe(200);
    expect(respond("/scripts/demo.ts").status).toBe(200);
  });

  it.each([
    "/src/mascot.test.ts",
    "/src/../package.json",
    "/src/%2e%2e/package.json",
    "/node_modules/react/index.js",
    "/scripts/missing.ts",
    "/README.md",
    "/src/palette.js",
  ])("refuses %s", (path) => {
    expect(respond(path).status).toBe(404);
  });
});
