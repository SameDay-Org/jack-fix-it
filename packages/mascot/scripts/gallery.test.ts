import { describe, expect, it } from "vitest";

import { READY_POSES } from "../src/index.ts";
import { BACKGROUNDS, galleryHtml, SIZES } from "./gallery.ts";

describe("the local gallery", () => {
  const html = galleryHtml();

  it("shows every ready pose at every size on white, light gray and navy", () => {
    for (const bg of BACKGROUNDS) expect(html).toContain(`id="poses-${bg.id}"`);
    const poses = [...html.matchAll(/<title id="(white|gray|navy)-([a-z]+)-(\d+)">/g)];
    expect(poses).toHaveLength(BACKGROUNDS.length * READY_POSES.length * SIZES.length);
    expect(new Set(poses.map((match) => match[3]))).toEqual(new Set(SIZES.map(String)));
  });

  it("shows the parts and is never indexed, with no script", () => {
    expect(html).toContain('id="parts"');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toMatch(/<script|href=/);
  });
});
