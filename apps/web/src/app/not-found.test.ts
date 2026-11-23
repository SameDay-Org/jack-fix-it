import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next/font runs in Next's compiler only: here a class name stands in for the site's font.
vi.mock("next/font/local", () => ({ default: () => ({ className: "site-font" }) }));

import NotFound, { generateMetadata } from "./not-found";

const page = async () => renderToStaticMarkup(await NotFound()).replaceAll("&#x27;", "'");

describe("the 404 page (#462)", () => {
  it("says it calmly in English and in Spanish, with the way home in each", async () => {
    const html = await page();

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("We can't find this page");
    expect(html).toMatch(/<div lang="es"[^>]*>.*No encontramos esta página/s);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Go to the home page<\/a>/);
    expect(html).toMatch(/<a lang="es"[^>]*href="\/es"[^>]*>Ir a la página de inicio<\/a>/);
    expect(html).not.toMatch(/ERROR|digest|404:/);
    expect((await generateMetadata()).title).toBe(
      "Page not found | John Got It · Página no encontrada | John Got It",
    );
  });

  // Reading the request (headers, cookies) in the root 404 makes every page of the site
  // dynamic: the landing, the showcase and the legal pages would stop being static.
  it("reads nothing from the request", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "not-found.tsx"), "utf8");
    expect(source).not.toMatch(/next\/headers|headers\(\)|cookies\(\)|searchParams/);
    expect(readdirSync(here)).not.toContain("global-not-found.tsx");
  });
});
