/**
 * `pnpm --filter @jack/mascot build`: writes each pose as a standalone, still SVG file
 * (dist/poses/): `<pose>.svg` (decorative) and `<pose>-titled.svg` (with its accessible name),
 * and the gallery (dist/gallery.html: its motion section needs the preview server). Fails when a
 * file is over its size budget. An optional argument writes to another directory instead of
 * dist/ (the build-output test does).
 *
 * No animated file: a standalone file has no script, so nothing would keep it still without
 * JavaScript, off screen or in a hidden tab. Jack moves only through the package's runtime (the
 * `animate` prop of `@jack/mascot/react`, or `@jack/mascot/dom`), which owns those gates.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { POSE_BUDGET_BYTES } from "../src/budget.ts";
import { poseNode, READY_POSES, renderSvg } from "../src/index.ts";
import { galleryHtml } from "./gallery.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(process.argv[2] ?? join(root, "dist"));
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "poses"), { recursive: true });

let over = 0;
const write = (name: string, svg: string, budget: number) => {
  const bytes = Buffer.byteLength(svg);
  writeFileSync(join(dist, "poses", name), svg);
  const ok = bytes < budget;
  if (!ok) over += 1;
  console.log(
    `${name}: ${(bytes / 1024).toFixed(1)} KB (budget ${budget / 1024} KB) ${ok ? "ok" : "OVER"}`,
  );
};

for (const pose of READY_POSES) {
  write(`${pose}.svg`, renderSvg(poseNode(pose)), POSE_BUDGET_BYTES);
  write(
    `${pose}-titled.svg`,
    renderSvg(poseNode(pose), { title: `Jack, ${pose}` }),
    POSE_BUDGET_BYTES,
  );
}
writeFileSync(join(dist, "gallery.html"), galleryHtml());
console.log("gallery.html written");
process.exit(over ? 1 : 0);
