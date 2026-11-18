// The first-load JavaScript of the public pages (the showcase, #403, and the landing, #85),
// against their budget.
//
// Run after `next build` (`pnpm --filter @jack/web check:bundle`). It reads the prerendered
// HTML of each public page, takes the scripts that HTML loads in a current browser (a chunk
// fetched later by a lazy import, such as the 3D hero, is not in it, and neither is the
// `nomodule` polyfill file that only old browsers run), gzips each one and fails when a
// page's sum is over the budget. It also fails when it finds no script at all: then the build
// output changed shape and the guard would be measuring nothing.
//
// The 3D hero (#403 PR 2) must stay out of the first load: the guard fails when a first-load
// script holds three.js, and measures the lazy chunk that does against its own budget. It
// fails when no chunk holds it either: the lazy import is gone, or the marker changed.
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUILD_DIR = new URL("../.next/", import.meta.url);

// The brief's performance budget: 150 KB of gzipped JavaScript on first load.
const BUDGET_BYTES = 150 * 1024;

// The 3D hero's chunk, fetched once the page has loaded: three.js and the scene (143 KB gzip
// when it was added). The budget keeps it from growing unnoticed.
const LAZY_3D_BUDGET_BYTES = 200 * 1024;

// A string three.js keeps in its minified code (its renderer's warnings).
const THREE_MARKER = "THREE.WebGLRenderer";

/** The public pages and their prerendered HTML in the build output. */
const PAGES = {
  "/": "server/app/index.html",
  "/es": "server/app/es.html",
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
  const sizes = scripts.map((file) => {
    const code = readFileSync(new URL(file, BUILD_DIR));
    return { file, gzip: gzipSync(code).byteLength, three: code.includes(THREE_MARKER) };
  });
  for (const { file } of sizes.filter(({ three }) => three)) {
    console.error(
      `${route}: ${file} is first-load JavaScript and holds three.js: the 3D hero must load later.`,
    );
    failed = true;
  }
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

// The lazy 3D chunk(s): every built chunk that holds three.js.
const chunksDir = new URL("static/chunks/", BUILD_DIR);
let lazy = [];
try {
  lazy = readdirSync(chunksDir, { recursive: true })
    .filter((name) => String(name).endsWith(".js"))
    .map((name) => ({ name: String(name), code: readFileSync(new URL(String(name), chunksDir)) }))
    .filter(({ code }) => code.includes(THREE_MARKER))
    .map(({ name, code }) => ({ name, gzip: gzipSync(code).byteLength }));
} catch {
  // No chunks directory: reported below as no 3D chunk.
}
if (lazy.length === 0) {
  console.error(
    "3D hero: no built chunk holds three.js; the lazy import is gone or the marker changed.",
  );
  failed = true;
} else {
  const total = lazy.reduce((sum, { gzip }) => sum + gzip, 0);
  const over = total > LAZY_3D_BUDGET_BYTES;
  failed ||= over;
  console.log(
    `3D hero (lazy, after the page): ${kilobytes(total)} gzip in ${lazy.length} file${lazy.length > 1 ? "s" : ""} ` +
      `(budget ${kilobytes(LAZY_3D_BUDGET_BYTES)}) ${over ? "OVER BUDGET" : "ok"}`,
  );
}

process.exit(failed ? 1 : 0);
