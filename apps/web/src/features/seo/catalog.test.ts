import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CATALOG_REVALIDATE_SECONDS,
  CATALOG_TAG,
  CatalogUnavailableError,
  findService,
  isPageSlug,
  loadCatalog,
  RESERVED_SLUGS,
  serviceCategories,
  servedPlace,
  servedRegions,
} from "./catalog";
import {
  CLEANING,
  PAINTING,
  POOLS,
  SOUTH_FLORIDA,
  TREASURE_COAST,
  catalogFetch,
} from "./seo-test-helpers";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "../../app");
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

/**
 * What the site answers right under a directory of src/app: its folders (route groups opened,
 * dynamic segments left out) and its metadata files (robots.ts → "robots").
 */
function staticNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (/^\(.+\)$/.test(entry.name)) names.push(...staticNames(join(dir, entry.name)));
      else if (!entry.name.startsWith("[")) names.push(entry.name);
    } else if (
      !/^(page|layout|loading|error|not-found|route|template|globals)\./.test(entry.name)
    ) {
      names.push(entry.name.replace(/\.[a-z]+$/, ""));
    }
  }
  return names;
}

describe("the reserved paths", () => {
  it("cover every path the site answers at its root and under /es", () => {
    const esDirs = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => /^\(.+\)$/.test(entry.name))
      .map((entry) => join(appDir, entry.name, "es"))
      .filter((dir) => {
        try {
          return readdirSync(dir).length > 0;
        } catch {
          return false;
        }
      });
    const names = [...staticNames(appDir), ...esDirs.flatMap(staticNames)];

    expect(names).toEqual(
      expect.arrayContaining(["admin", "api", "app", "es", "for-pros", "robots"]),
    );
    for (const name of names) expect(isPageSlug(name), name).toBe(false);
  });

  it("refuse Next's generated image paths and malformed slugs, accept a plain one", () => {
    for (const slug of [
      "opengraph-image-1pnh59",
      "twitter-image-x1",
      "icon-0",
      ...RESERVED_SLUGS,
    ]) {
      expect(isPageSlug(slug), slug).toBe(false);
    }
    for (const slug of ["", "House", "a--b", "-a", "a-", "a_b", "a/b", "icon.svg", "é"]) {
      expect(isPageSlug(slug), slug).toBe(false);
    }
    for (const slug of ["house-cleaning", "painting", "pool-care-2"]) {
      expect(isPageSlug(slug), slug).toBe(true);
    }
  });
});

describe("the services that get a page", () => {
  it("are the active categories, in the API's order, while a city is served", () => {
    const catalog = { categories: [PAINTING, CLEANING], regions: [SOUTH_FLORIDA] };

    expect(serviceCategories(catalog).map((c) => c.slug)).toEqual(["painting", "house-cleaning"]);
    expect(findService(catalog, "house-cleaning")).toBe(CLEANING);
    expect(findService(catalog, "handyman")).toBeNull();
  });

  it("leave out a reserved or malformed slug, and a second category with the same slug", () => {
    const app = { ...POOLS, slug: "app" };
    const odd = { ...POOLS, slug: "Pool Care" };
    const twin = { ...CLEANING, id: "0b6c1a52-1111-4222-8333-944455556699" };
    const catalog = { categories: [app, odd, CLEANING, twin], regions: [SOUTH_FLORIDA] };

    expect(serviceCategories(catalog)).toEqual([CLEANING]);
    expect(findService(catalog, "app")).toBeNull();
  });

  it("are none while no city has an active ZIP", () => {
    const empty = {
      ...SOUTH_FLORIDA,
      cities: SOUTH_FLORIDA.cities.map((c) => ({ ...c, zips: [] })),
    };

    expect(serviceCategories({ categories: [CLEANING], regions: [] })).toEqual([]);
    expect(serviceCategories({ categories: [CLEANING], regions: [empty] })).toEqual([]);
    expect(findService({ categories: [CLEANING], regions: [empty] }, "house-cleaning")).toBeNull();
  });

  it("name the region when Jack serves one, none when several", () => {
    const empty = { ...TREASURE_COAST, cities: [{ ...TREASURE_COAST.cities[0], zips: [] }] };

    expect(servedPlace({ categories: [], regions: [SOUTH_FLORIDA] })).toBe("South Florida");
    expect(servedPlace({ categories: [], regions: [SOUTH_FLORIDA, empty] })).toBe("South Florida");
    expect(servedPlace({ categories: [], regions: [SOUTH_FLORIDA, TREASURE_COAST] })).toBeNull();
    expect(servedRegions({ categories: [], regions: [SOUTH_FLORIDA, empty] })).toEqual([
      SOUTH_FLORIDA,
    ]);
  });
});

describe("the catalog read", () => {
  it("asks the API once per route through Next's data cache, under one tag, for an hour", async () => {
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    fetchMock.mockImplementation(catalogFetch([CLEANING], [SOUTH_FLORIDA], calls));

    await expect(loadCatalog()).resolves.toEqual({
      categories: [CLEANING],
      regions: [SOUTH_FLORIDA],
    });
    expect(calls.map((call) => call.path).sort()).toEqual(["/v1/categories", "/v1/service-areas"]);
    for (const { init } of calls) {
      expect(init).toMatchObject({
        method: "GET",
        next: { revalidate: CATALOG_REVALIDATE_SECONDS, tags: [CATALOG_TAG] },
      });
      expect(init?.cache).toBeUndefined(); // no "no-store": the data cache keeps the answer
    }
  });

  it.each([
    ["the API is unreachable", () => Promise.reject(new TypeError("fetch failed"))],
    ["the API fails", () => Promise.resolve(new Response(null, { status: 503 }))],
    ["the API limits the web server", () => Promise.resolve(new Response(null, { status: 429 }))],
  ])("throws when %s, and gives nothing half-read", async (_case, failure) => {
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/service-areas") return failure();
      return catalogFetch([CLEANING], [SOUTH_FLORIDA])(input, init);
    });

    await expect(loadCatalog()).rejects.toBeInstanceOf(CatalogUnavailableError);
  });
});
