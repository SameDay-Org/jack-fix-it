import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The web service's key (WEB_SERVICE_KEY, #409/#530) and the form secret stay on the server:
// no client component reaches, through its imports, a module that reads them, and no public
// (NEXT_PUBLIC_) variable carries a key or a secret.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = ["WEB_SERVICE_KEY", "INTEREST_FORM_SECRET"];
const IMPORT = /^(?:import|export) (?!type )[^;]*? from "([^"]+)";/gm;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The file an import names, for this app's own modules (`@/…` or relative); null otherwise. */
function resolveImport(from: string, name: string): string | null {
  let base: string;
  if (name.startsWith("@/")) base = join(SRC, name.slice(2));
  else if (name.startsWith(".")) base = resolve(dirname(from), name);
  else return null;
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  if (existsSync(base) && statSync(base).isFile()) candidates.unshift(base);
  return candidates.find((path) => existsSync(path)) ?? null;
}

const files = sources(SRC);
const clients = files.filter((file) => readFileSync(file, "utf8").startsWith('"use client";'));

describe("the web service's key stays on the server", () => {
  it("no client component reaches a module that reads it", () => {
    expect(clients.map((file) => relative(SRC, file))).toContain(
      join("app", "admin", "session", "busy", "retry-once.tsx"),
    );
    const reached = new Set<string>();
    const queue = [...clients];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (reached.has(file)) continue;
      const code = readFileSync(file, "utf8");
      // A server action module reaches the browser as references only: its code stays here.
      if (code.startsWith('"use server";')) continue;
      reached.add(file);
      for (const [, name] of code.matchAll(IMPORT)) {
        const target = resolveImport(file, name!);
        if (target) queue.push(target);
      }
    }
    for (const file of reached) {
      const source = readFileSync(file, "utf8");
      for (const secret of SECRETS) expect(source, relative(SRC, file)).not.toContain(secret);
    }
  });

  it("no public variable carries a key or a secret", () => {
    for (const file of files) {
      expect(readFileSync(file, "utf8"), relative(SRC, file)).not.toMatch(
        /NEXT_PUBLIC_\w*(KEY|SECRET|TOKEN)/,
      );
    }
  });
});
