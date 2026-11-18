/**
 * What the local preview answers (preview.ts serves it): the gallery page, and the package's own
 * modules as JavaScript (types stripped by Node) for the gallery's motion section. Nothing else:
 * never a test, a file outside `src/` and `scripts/`, or a path that climbs out.
 */
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { galleryHtml } from "./gallery.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The only files served besides the page. */
const MODULE = /^\/(src|scripts)\/(parts\/)?[a-z0-9-]+\.ts$/;

export const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'",
} as const;

export type Answer = { status: 200 | 404; type: string; body: string };

export function respond(path: string): Answer {
  if (path === "/" || path === "/index.html") {
    return { status: 200, type: "text/html; charset=utf-8", body: galleryHtml() };
  }
  const file = join(root, path);
  if (MODULE.test(path) && !path.endsWith(".test.ts") && existsSync(file)) {
    return {
      status: 200,
      type: "text/javascript; charset=utf-8",
      body: stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }),
    };
  }
  return { status: 404, type: "text/plain; charset=utf-8", body: "Not found" };
}
