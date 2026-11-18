import { MASCOT_POSES, poseNode, renderSvg } from "@jack/mascot";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GET, generateStaticParams } from "@/app/mascot/[file]/route";

import { MascotImage, mascotImagePath } from "./mascot-image";

function get(file: string): Promise<Response> {
  return GET(new Request(`http://site.test/mascot/${file}`), {
    params: Promise.resolve({ file }),
  });
}

describe("the still mascot images", () => {
  it("are built for the six poses, no more", () => {
    expect(generateStaticParams()).toEqual(MASCOT_POSES.map((pose) => ({ file: `${pose}.svg` })));
  });

  it.each(MASCOT_POSES)(
    "serve %s as the package draws it, where the image points",
    async (pose) => {
      const path = mascotImagePath(pose);
      const response = await get(path.slice("/mascot/".length));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
      expect(await response.text()).toBe(renderSvg(poseNode(pose)));
    },
  );

  it.each(["dance.svg", "wave", "wave.svg.png", "..%2Fwave.svg"])(
    "answer 404 for %s",
    async (file) => {
      expect((await get(file)).status).toBe(404);
    },
  );

  it("is a lazy, decorative image unless it has a title", () => {
    const html = renderToStaticMarkup(
      createElement(MascotImage, { pose: "tools", size: 112, className: "rounded-3xl" }),
    );
    expect(html).toBe(
      '<img src="/mascot/tools.svg" alt="" width="112" height="112" loading="lazy" decoding="async" data-pose="tools" class="rounded-3xl"/>',
    );
    expect(
      renderToStaticMarkup(createElement(MascotImage, { pose: "wave", title: "Jack waves" })),
    ).toContain('alt="Jack waves"');
  });
});
