import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Locale } from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { FOR_PROS_ANCHORS, ForProsPage } from "./for-pros-page";
import { forProsMetadata } from "./metadata";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "../../app");
const CATALOGS = { en, es } as const;

beforeEach(() => {
  vi.stubEnv("CONTACT_EMAIL", "");
  vi.stubEnv("SITE_URL", "");
  // The page reads nothing from the API: any call is a mistake.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("the page for pros asked the network"))),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

async function page(locale: Locale): Promise<string> {
  return decoded(renderToStaticMarkup(await ForProsPage({ locale })));
}

/** The site's routes, from the page files under src/app (route groups are not in the URL). */
function routes(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const group = /^\(.+\)$/.test(entry.name);
        walk(join(dir, entry.name), group ? segments : [...segments, entry.name]);
      } else if (entry.name === "page.tsx") {
        found.add(`/${segments.join("/")}`);
      }
    }
  };
  walk(appDir, []);
  return found;
}

function strings(value: unknown): string[] {
  return typeof value === "string" ? [value] : Object.values(value as object).flatMap(strings);
}

describe("the page for professionals", () => {
  it("is a route in both languages", () => {
    expect(routes()).toContain("/for-pros");
    expect(routes()).toContain("/es/for-pros");
  });

  it.each(["en", "es"] as const)("in %s has one h1 and its sections in order", async (locale) => {
    const html = await page(locale);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(Object.values(FOR_PROS_ANCHORS));
    // The landmarks: a header, one main (where "Skip to content" lands), a footer.
    expect(html).toMatch(/<a href="#content"[^>]*>/);
    expect(html.match(/<main id="content">/g)).toHaveLength(1);
    expect(html).toMatch(/<header\b/);
    expect(html).toMatch(/<footer\b/);
  });

  it("links only to anchors that are on the page", async () => {
    const html = await page("en");
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]!);
    expect(new Set(anchors)).toEqual(new Set(["content", "how", "faq"]));
    for (const anchor of anchors) expect(html).toContain(`id="${anchor}"`);
  });

  it.each(["en", "es"] as const)("in %s links only to pages that exist", async (locale) => {
    const html = await page(locale);
    const known = routes();
    const internal = [...html.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1]!);
    expect(internal.length).toBeGreaterThan(4);
    for (const href of internal) {
      const path = href.split(/[?#]/)[0]!;
      expect(known, href).toContain(path === "" ? "/" : path);
    }
  });

  it.each([
    ["en", "/app", "/", "/es/for-pros"],
    ["es", "/es/app", "/es", "/for-pros"],
  ] as const)(
    "in %s sends pros to the app, home to the landing, and to its twin",
    async (locale, app, home, twin) => {
      const html = await page(locale);
      const getApp = CATALOGS[locale].forPros.hero.getApp;
      const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
      // The hero's and the last section's: both to the app, where pros sign up.
      const toApp = main.match(new RegExp(`<a [^>]*href="${app}"[^>]*>${getApp}</a>`, "g"));
      expect(toApp).toHaveLength(2);
      expect(html).toContain(
        `<a href="${home}" aria-label="${CATALOGS[locale].landing.homeLabel}"`,
      );
      expect(html).toContain(`href="${twin}"`);
      // Pros sign up in the app only: no form, no sign-in.
      expect(html).not.toMatch(/<form\b|<input\b|type="password"/);
    },
  );

  it("shows the three approved badges, word for word", async () => {
    const html = await page("en");
    const list = /<ul aria-label="Working with Jack"[^>]*>(.*?)<\/ul>/.exec(html)?.[1] ?? "";
    const badges = [...list.matchAll(/<\/svg>([^<]+)<\/li>/g)].map((match) => match[1]);
    expect(badges).toEqual([
      "No lead fees",
      "Get paid when the job happens",
      "Clear service records",
    ]);
  });

  it("walks the pro's way in, in five steps", async () => {
    const html = await page("en");
    const steps = /<section id="how"[^>]*>.*?<ol[^>]*>(.*?)<\/ol>/.exec(html)?.[1] ?? "";
    expect([...steps.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1])).toEqual([
      "Create your profile",
      "Our team reviews your documents",
      "Set up payouts",
      "Get requests that match you",
      "Quote, do the job, get paid",
    ]);
  });

  it("says only approved pros receive requests", async () => {
    expect(await page("en")).toContain("Only approved pros receive requests.");
    expect(await page("es")).toContain("Solo los profesionales aprobados reciben solicitudes.");
  });

  it.each(["en", "es"] as const)(
    "in %s answers its questions in native disclosures a keyboard opens",
    async (locale) => {
      const html = await page(locale);
      const items = [
        ...html.matchAll(/<details name="for-pros-faq"[^>]*><summary class="([^"]*)">([^<]+)/g),
      ];
      expect(items.map((match) => match[2])).toEqual(
        Object.values(CATALOGS[locale].forPros.faq.items).map((item) => item.question),
      );
      expect(items.length).toBeGreaterThanOrEqual(4);
      expect(items.length).toBeLessThanOrEqual(6);
      // A summary is reached with Tab and opens with Enter or Space: nothing may take that away.
      for (const [, classes] of items) expect(classes).toContain("focus-visible:ring-2");
      expect(html).not.toMatch(/<summary[^>]*tabindex="-1"/);
      // Every answer is in the page, for a reader without script.
      for (const item of Object.values(CATALOGS[locale].forPros.faq.items))
        expect(html).toContain(item.answer);
    },
  );

  it("draws Jack from the mascot package as still images only", async () => {
    const html = await page("en");
    expect(html).not.toMatch(/<svg[^>]*data-pose=|data-part=|data-motion/);
    const images = html.match(/<img[^>]*data-pose="[^"]*"[^>]*>/g) ?? [];
    expect(images.map((image) => /data-pose="([^"]*)"/.exec(image)?.[1])).toEqual([
      "tools",
      "wave",
      "thinking",
      "point",
      "peek",
      "tools",
      "celebrate",
    ]);
    expect(images.every((image) => image.includes('loading="lazy"'))).toBe(true);
  });

  it.each(["en", "es"] as const)("in %s asks nothing of another site", async (locale) => {
    const html = (await page(locale)).replaceAll('xmlns="http://www.w3.org/2000/svg"', "");
    expect(html).not.toMatch(/https?:\/\/|<script[^>]+src=|<iframe|<link[^>]+href="http/);
  });
});

describe("the page for professionals' copy", () => {
  // The legal words (insurance, licence, warranty, escrow, refund, held money, "verified") are
  // the shared public-copy policy's: i18n/public-copy.test.ts reads `forPros` too, with no
  // exception for it. Here, what a page for pros must never say: a number of any kind (no
  // price, fee, percentage, count, deadline or income), "free", earnings, ratings, a sign-in.
  const absent: Record<Locale, RegExp> = {
    en: /\d|%|\$|\bfree\b|\bearn|income|\bratings?\b|\bstars?\b|sign[ -]?in|log[ -]?in|guarant/i,
    es: /\d|%|\$|gratis|gratuit|ingreso|ganancia|calificaci|estrellas|inici(a|ar) sesi|garant/i,
  };

  it.each(["en", "es"] as const)("in %s states no number and no promise", (locale) => {
    for (const text of strings(CATALOGS[locale].forPros))
      expect(text, text).not.toMatch(absent[locale]);
  });

  it.each(["en", "es"] as const)(
    "in %s names documents only 'where applicable', never as something every pro holds",
    (locale) => {
      const { ask, faq } = CATALOGS[locale].forPros;
      const where = locale === "en" ? "where applicable" : "cuando corresponde";
      expect(ask.items.documents).toContain(where);
      expect(faq.items.documents.answer).toContain(where);
    },
  );
});

describe("the page for professionals' metadata", () => {
  it.each(["en", "es"] as const)(
    "in %s has its title and description, and no address without SITE_URL",
    async (locale) => {
      const metadata = await forProsMetadata(locale);
      expect(metadata.title).toBe(CATALOGS[locale].forPros.meta.title);
      expect(metadata.description).toBe(CATALOGS[locale].forPros.meta.description);
      expect(metadata.alternates).toBeUndefined();
      expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
    },
  );

  it.each([
    ["en", "/for-pros"],
    ["es", "/es/for-pros"],
  ] as const)("in %s names itself and its twin with SITE_URL", async (locale, canonical) => {
    vi.stubEnv("SITE_URL", "https://jackfixit.test");
    const metadata = await forProsMetadata(locale);
    expect(metadata.alternates).toEqual({
      canonical,
      languages: { en: "/for-pros", es: "/es/for-pros", "x-default": "/for-pros" },
    });
    expect(metadata.openGraph).toMatchObject({
      url: canonical,
      locale: locale === "en" ? "en_US" : "es_US",
    });
  });
});
