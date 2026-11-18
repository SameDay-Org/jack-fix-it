import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { poseNode, READY_POSES } from "./poses.ts";
import { Mascot } from "./react.ts";
import { renderSvg } from "./render.ts";

function markup(props: Parameters<typeof Mascot>[0]): string {
  return renderToStaticMarkup(createElement(Mascot, props));
}

/**
 * The drawing without the root element and the title: what both renderers must agree on. React
 * closes an empty SVG element with its end tag (`<rect …></rect>`), the string renderer with `/>`.
 */
function drawing(svg: string): string {
  return svg
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "")
    .replace(/<title[^>]*>.*?<\/title>/, "")
    .replace(/<(path|circle|ellipse|rect)([^<>]*)><\/\1>/g, "<$1$2/>");
}

describe("<Mascot> for the web", () => {
  it("is an image named by its title", () => {
    const html = markup({ pose: "wave", title: "Jack waves hello" });
    const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(/^<svg [^>]*role="img"/);
    expect(id).toBeTruthy();
    expect(html).toContain(`<title id="${id}">Jack waves hello</title>`);
    expect(html).not.toContain("aria-hidden");
  });

  it("is decoration, hidden from assistive tech, without a title", () => {
    const html = markup({ pose: "celebrate" });
    expect(html).toMatch(/aria-hidden="true"/);
    expect(html).toMatch(/focusable="false"/);
    expect(html).not.toMatch(/role=|<title/);
  });

  it("takes its size and class like the showcase's component", () => {
    expect(markup({ pose: "tools" })).toMatch(/width="120" height="120"/);
    const html = markup({ pose: "tools", size: 48, className: "mascot shadow" });
    expect(html).toMatch(/width="48" height="48"/);
    expect(html).toContain('class="mascot shadow"');
    expect(html).toContain('viewBox="0 0 200 200"');
  });

  it.each(READY_POSES)("draws %s exactly as the SVG renderer does", (pose) => {
    expect(drawing(markup({ pose }))).toBe(drawing(renderSvg(poseNode(pose))));
  });
});
