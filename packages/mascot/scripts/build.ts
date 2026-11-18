/**
 * `pnpm --filter @jack/mascot build`: writes each pose as a standalone SVG file (dist/poses/):
 * `<pose>.svg` (still, decorative), `<pose>-titled.svg` (still, with its accessible name) and
 * `<pose>-animated.svg` (the idle loops in CSS, off under Reduce Motion), and the gallery
 * (dist/gallery.html: its motion section needs the preview server). Fails when a file is over
 * its size budget.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ANIMATED_POSE_BUDGET_BYTES, POSE_BUDGET_BYTES } from "../src/budget.ts";
import { idleCss, poseNode, READY_POSES, renderSvg, RIGS } from "../src/index.ts";
import { galleryHtml } from "./gallery.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
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
  // A file has no script to pause it off screen: it simply runs, unless motion is reduced.
  const scope = `jack-${pose}`;
  const motion = { scope, state: "running" as const, css: idleCss(scope, RIGS[pose]) };
  write(`${pose}-animated.svg`, renderSvg(poseNode(pose), { motion }), ANIMATED_POSE_BUDGET_BYTES);
}
writeFileSync(join(dist, "gallery.html"), galleryHtml());
console.log("gallery.html written");
process.exit(over ? 1 : 0);
