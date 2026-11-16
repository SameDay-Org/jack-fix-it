// The first-load JavaScript of the showcase page, against its budget (#403).
//
// Run after `next build` (`pnpm --filter @jack/web check:bundle`). It reads the prerendered
// HTML of each showcase page, takes the scripts that HTML loads in a current browser (a chunk
// fetched later by a lazy import, such as the 3D hero, is not in it, and neither is the
// `nomodule` polyfill file that only old browsers run), gzips each one and fails when a
// page's sum is over the budget. It also fails when it finds no script at all: then the build
// output changed shape and the guard would be measuring nothing.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUILD_DIR = new URL("../.next/", import.meta.url);

// The brief's performance budget: 150 KB of gzipped JavaScript on first load.
const BUDGET_BYTES = 150 * 1024;

/** The showcase pages and their prerendered HTML in the build output. */
const PAGES = {
  "/app": "server/app/app.html",
  "/es/app": "server/app/es/app.html",
};

const STATIC_SCRIPT = /^\/_next\/(static\/[^"?#]+\.js)(?:[?#].*)?$/;

/** The build-output paths of the scripts a page's HTML loads, each once. */
function firstLoadScripts(html) {
  const sources = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const isScript = tag.startsWith("<script");
    // A `nomodule` script is the polyfill file: a current browser never fetches it.
    if (isScript && / nomodule\b/i.test(tag)) continue;
    const isScriptPreload = !isScript && /\bas="script"/.test(tag);
    if (!isScript && !isScriptPreload) continue;
    const url = (isScript ? /\bsrc="([^"]+)"/ : /\bhref="([^"]+)"/).exec(tag)?.[1];
    const file = url ? STATIC_SCRIPT.exec(url)?.[1] : undefined;
    if (file) sources.add(file);
  }
  return [...sources];
}

function kilobytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

let failed = false;
for (const [route, htmlPath] of Object.entries(PAGES)) {
  let html;
  try {
    html = readFileSync(new URL(htmlPath, BUILD_DIR), "utf8");
  } catch {
    console.error(`${route}: no ${htmlPath} in .next. Run "next build" first.`);
    failed = true;
    continue;
  }
  const scripts = firstLoadScripts(html);
  if (scripts.length === 0) {
    console.error(`${route}: found no script in ${htmlPath}; the guard measures nothing.`);
    failed = true;
    continue;
  }
  const sizes = scripts.map((file) => ({
    file,
    gzip: gzipSync(readFileSync(new URL(file, BUILD_DIR))).byteLength,
  }));
  const total = sizes.reduce((sum, { gzip }) => sum + gzip, 0);
  const over = total > BUDGET_BYTES;
  failed ||= over;
  console.log(
    `${route}: ${kilobytes(total)} gzip of first-load JavaScript in ${scripts.length} files ` +
      `(budget ${kilobytes(BUDGET_BYTES)}) ${over ? "OVER BUDGET" : "ok"}`,
  );
  if (over || process.argv.includes("--verbose")) {
    for (const { file, gzip } of sizes.sort((a, b) => b.gzip - a.gzip)) {
      console.log(`  ${kilobytes(gzip).padStart(9)}  ${file}`);
    }
  }
}

process.exit(failed ? 1 : 0);
