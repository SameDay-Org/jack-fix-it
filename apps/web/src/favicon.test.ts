import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import nextConfig, { FAVICON } from "../next.config";

describe("/favicon.ico (#546)", () => {
  it("is the site's own icon, not a 404", async () => {
    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toEqual([{ source: "/favicon.ico", destination: "/icon.svg" }]);
    expect(FAVICON).toBe("/icon.svg");
    // The destination is the icon Next serves from the app directory.
    const app = join(dirname(fileURLToPath(import.meta.url)), "app");
    expect(existsSync(join(app, "icon.svg"))).toBe(true);
  });
});
