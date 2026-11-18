/**
 * `pnpm --filter @jack/mascot build`: writes each ready pose as a standalone SVG file
 * (dist/poses/<pose>.svg, decorative, and dist/poses/<pose>-titled.svg with its accessible
 * name) and the gallery (dist/gallery.html), and fails when a pose is over its size budget.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { POSE_BUDGET_BYTES } from "../src/budget.ts";
import { poseNode, READY_POSES, renderSvg } from "../src/index.ts";
import { galleryHtml } from "./gallery.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "poses"), { recursive: true });

let over = 0;
for (const pose of READY_POSES) {
  const svg = renderSvg(poseNode(pose));
  const bytes = Buffer.byteLength(svg);
  writeFileSync(join(dist, "poses", `${pose}.svg`), svg);
  writeFileSync(
    join(dist, "poses", `${pose}-titled.svg`),
    renderSvg(poseNode(pose), { title: `Jack, ${pose}` }),
  );
  const ok = bytes < POSE_BUDGET_BYTES;
  if (!ok) over += 1;
  console.log(
    `${pose}.svg: ${(bytes / 1024).toFixed(1)} KB (budget ${POSE_BUDGET_BYTES / 1024} KB) ${ok ? "ok" : "OVER"}`,
  );
}
writeFileSync(join(dist, "gallery.html"), galleryHtml());
console.log("gallery.html written");
process.exit(over ? 1 : 0);
