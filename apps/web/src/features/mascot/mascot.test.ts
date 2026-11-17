import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Mascot, MASCOT_POSES, type MascotProps } from "./mascot";

function render(props: MascotProps): string {
  return renderToStaticMarkup(createElement(Mascot, props));
}

describe("Mascot", () => {
  it("offers the six poses the pages ask for", () => {
    expect([...MASCOT_POSES]).toEqual(["wave", "point", "celebrate", "peek", "thinking", "tools"]);
  });

  it.each(MASCOT_POSES)("draws the %s pose as one square SVG", (pose) => {
    const svg = render({ pose });

    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 200 200"/);
    expect(svg).toContain(`data-pose="${pose}"`);
    // Something is drawn, and only with the brand's tokens: no color written by hand.
    expect(svg).toMatch(/<(path|circle|rect)/);
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });

  it("draws every pose differently", () => {
    const drawings = MASCOT_POSES.map((pose) => render({ pose }).replace(/data-pose="[^"]*"/, ""));

    expect(new Set(drawings).size).toBe(MASCOT_POSES.length);
  });

  it("is decoration unless it is given a name", () => {
    const decoration = render({ pose: "wave" });
    expect(decoration).toContain('aria-hidden="true"');
    expect(decoration).not.toContain("role=");
    expect(decoration).not.toContain("aria-label");

    const named = render({ pose: "wave", title: "Jack waves" });
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Jack waves"');
    expect(named).not.toContain("aria-hidden");
  });

  it("takes its size in pixels, 120 unless told otherwise, and extra classes", () => {
    expect(render({ pose: "tools" })).toMatch(/width="120" height="120"/);
    expect(render({ pose: "tools", size: 48 })).toMatch(/width="48" height="48"/);
    expect(render({ pose: "tools", className: "size-full" })).toMatch(/class="[^"]*size-full/);
  });

  it("never takes the keyboard focus", () => {
    expect(render({ pose: "peek" })).toContain('focusable="false"');
  });
});
