import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POSE_BUDGET_BYTES } from "../src/budget.ts";
import { READY_POSES } from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let out = "";
let files: { name: string; text: string }[] = [];

/** Every file under a directory, by its path from there. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// The package's own `build` script, as `pnpm build` runs it, into a directory of the test's.
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "jack-mascot-build-"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: { build: string };
  };
  const [command, ...args] = pkg.scripts.build.split(" ");
  expect(command).toBe("node");
  execFileSync(process.execPath, [...args, out], { cwd: root, stdio: "pipe" });
  files = walk(out).map((path) => ({
    name: relative(out, path).replaceAll("\\", "/"),
    text: readFileSync(path, "utf8"),
  }));
}, 60_000);

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

/** Anything that moves without a script: SMIL, CSS animations or transitions, a running state. */
const MOTION =
  /<(animate\w*|set)[\s/>]|\b(animation|transition)(-[a-z-]+)?\s*:|@keyframes|data-motion="running"/;

describe("the build output", () => {
  it("is the still poses, plain and titled, and the gallery: no animated file", () => {
    expect(files.map((file) => file.name).sort()).toEqual(
      [
        "gallery.html",
        ...READY_POSES.flatMap((pose) => [`poses/${pose}.svg`, `poses/${pose}-titled.svg`]),
      ].sort(),
    );
  });

  it("has no file that moves by itself, without JavaScript or off screen", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file.text, file.name).not.toMatch(MOTION);
  });

  it("draws every pose still: no script, no style, no motion state, under its budget", () => {
    const svgs = files.filter((file) => file.name.endsWith(".svg"));
    expect(svgs).toHaveLength(READY_POSES.length * 2);
    for (const svg of svgs) {
      expect(svg.text, svg.name).toMatch(/^<svg /);
      expect(svg.text, svg.name).not.toMatch(/<script|<style|data-motion/);
      expect(Buffer.byteLength(svg.text), svg.name).toBeLessThan(POSE_BUDGET_BYTES);
    }
  });

  it("gives the gallery its motion only through the package's runtime", () => {
    const gallery = files.find((file) => file.name === "gallery.html")?.text ?? "";
    expect(gallery).not.toContain(".svg");
    expect([...gallery.matchAll(/<script[^>]*>/g)].map((match) => match[0])).toEqual([
      '<script type="module" src="/scripts/demo.ts">',
    ]);
  });
});
