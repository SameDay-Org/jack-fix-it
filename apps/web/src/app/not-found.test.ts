import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requested } = vi.hoisted(() => ({ requested: { path: null as string | null } }));
// next/font runs in Next's compiler only: here a class name stands in for the site's font.
vi.mock("next/font/local", () => ({ default: () => ({ className: "site-font" }) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(requested.path === null ? {} : { "x-jfi-path": requested.path }),
}));

import NotFound, { generateMetadata } from "./not-found";

beforeEach(() => {
  requested.path = null;
});

async function page(path: string | null): Promise<string> {
  requested.path = path;
  return renderToStaticMarkup(await NotFound()).replaceAll("&#x27;", "'");
}

describe("the 404 page (#462)", () => {
  it("speaks English with the way home on an English address", async () => {
    const html = await page("/no-such-page?x=1");

    expect(html).toMatch(/<main lang="en"/);
    expect(html).toContain("<h1");
    expect(html).toContain("We can't find this page");
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Go to the home page<\/a>/);
    expect((await generateMetadata()).title).toBe("Page not found | Jack Fix It");
  });

  it.each(["/es/no-such-page", "/es", "/es/a/b/c?utm=1"])(
    "speaks Spanish under /es (%s)",
    async (path) => {
      const html = await page(path);

      expect(html).toMatch(/<main lang="es"/);
      expect(html).toContain("No encontramos esta página");
      expect(html).toMatch(/<a[^>]*href="\/es"[^>]*>Ir a la página de inicio<\/a>/);
      expect((await generateMetadata()).title).toBe("Página no encontrada | Jack Fix It");
    },
  );

  it("keeps the panel's look and leads back to the panel under /admin", async () => {
    const html = await page("/admin/no-such-page");

    expect(html).toContain("This panel page doesn't exist");
    expect(html).toMatch(/<a[^>]*href="\/admin"[^>]*>Back to the panel<\/a>/);
    expect(html).not.toContain("Go to the home page");
  });

  it("falls back to English without the proxy's header, and never shows an error code", async () => {
    const html = await page(null);

    expect(html).toContain("We can't find this page");
    expect(html).not.toMatch(/ERROR|digest|404:/);
  });
});
