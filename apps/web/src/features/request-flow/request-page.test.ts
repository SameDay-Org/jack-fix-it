import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import nextConfig from "../../../next.config";
import type { Locale } from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import { getT } from "@/i18n/server";
import { routeFetch } from "@/lib/test-helpers";

import { checkFormToken } from "@/lib/public-form/form-token";

import { requestFlowText } from "./copy";
import { requestMetadata } from "./metadata";
import type { RequestFlowProps } from "./request-flow";
import { preselectedCategoryId, RequestPage } from "./request-page";
import type { RequestCategory } from "./server";

/** What the page handed the flow the last time it showed it. */
const handed = vi.hoisted(() => ({ props: null as RequestFlowProps | null }));
vi.mock("./request-flow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./request-flow")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    RequestFlow: (props: RequestFlowProps) => {
      handed.props = props;
      return createElement(actual.RequestFlow, props);
    },
  };
});

const FORM_SECRET = "form-secret-for-tests-0123456789abcdef";

const fetchMock = vi.fn<typeof fetch>();

const HANDYMAN = {
  id: "6b3c0e1d-1111-4222-8333-944455556666",
  slug: "handyman",
  names: { en: "Handyman", es: "Reparaciones generales" },
  icon: null,
  requires_license: false,
  intake_questions: [],
};

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("CONTACT_EMAIL", "");
  vi.stubEnv("REQUEST_FLOW_ENABLED", "true");
  vi.stubEnv("REQUEST_FORM_SECRET", FORM_SECRET);
  vi.stubEnv("APP_STORE_URL", "");
  vi.stubEnv("PLAY_STORE_URL", "");
  vi.stubEnv("WEB_SERVICE_KEY", "web-service-key-for-tests-0123456789");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(routeFetch({ "/v1/categories": () => Response.json([HANDYMAN]) }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

async function page(locale: Locale, search = {}): Promise<string> {
  return decoded(renderToStaticMarkup(await RequestPage({ locale, search })));
}

describe("the request page (#86)", () => {
  it("is a 404 while REQUEST_FLOW_ENABLED is off: nothing that does not work is shown", async () => {
    for (const value of ["", "false", "1", "TRUE"]) {
      vi.stubEnv("REQUEST_FLOW_ENABLED", value);
      await expect(RequestPage({ locale: "en", search: {} }), value).rejects.toMatchObject({
        digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/),
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["en", en, "/es/request"],
    ["es", es, "/request"],
  ] as const)(
    "in %s starts with the ZIP code, in the page's language",
    async (locale, catalog, other) => {
      const html = await page(locale);
      expect(html).toContain(`<div lang="${locale}">`);
      expect(html).toMatch(new RegExp(`<h1[^>]*>${catalog.request.title}</h1>`));
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).toContain(catalog.request.zip.title);
      expect(html).toMatch(/<input id="request-zip"[^>]*autoComplete="postal-code"/i);
      expect(html).toContain(catalog.request.noscript);
      expect(html).toContain('<main id="content"');
      // The language switch leads to the same form in the other language.
      expect(html).toContain(`href="${other}"`);
      // No step a visitor cannot finish yet: no address, no contact, no send.
      expect(html).not.toMatch(/type="submit"[^>]*>(Send|Enviar)/);
    },
  );

  it("hands the flow the campaign of its address, a token for this form, the stores once set", async () => {
    await page("en", { utm_source: "google", utm_campaign: "launch", service: "x" });
    expect(handed.props?.utm).toEqual({ source: "google", campaign: "launch" });
    // A token for the request form (not the interest form's), old enough once the visitor sends.
    const timings = { minSeconds: 3, maxAgeSeconds: 3600 };
    const later = Date.now() + 60_000;
    const token = handed.props?.formToken;
    expect(checkFormToken(token, FORM_SECRET, "request", later, timings).ok).toBe(true);
    expect(handed.props?.storeLinks).toBeNull();

    vi.stubEnv("APP_STORE_URL", "https://apps.apple.com/app/id100");
    vi.stubEnv("PLAY_STORE_URL", "https://play.google.com/store/apps/details?id=x");
    await page("en");
    expect(handed.props?.utm).toBeNull();
    expect(handed.props?.storeLinks).toEqual({
      appStore: "https://apps.apple.com/app/id100",
      playStore: "https://play.google.com/store/apps/details?id=x",
    });
  });

  it("reads the services once for every visitor (cached for an hour), not once each", async () => {
    await page("en");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/v1/categories");
    expect((init as RequestInit & { next?: { revalidate?: number } }).next).toEqual({
      revalidate: 3600,
    });
  });

  it.each(["REQUEST_FORM_SECRET", "WEB_SERVICE_KEY"])(
    "fails without %s: a form that cannot be sent is never shown",
    async (name) => {
      for (const value of ["", "too-short"]) {
        vi.stubEnv(name, value);
        await expect(RequestPage({ locale: "en", search: {} }), value).rejects.toThrow(name);
      }
    },
  );

  it("still opens when the services cannot be read", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await page("en")).toContain(en.request.zip.title);
  });

  it("is never indexed, in either language", async () => {
    for (const [locale, catalog] of [
      ["en", en],
      ["es", es],
    ] as const) {
      const metadata = await requestMetadata(locale);
      expect(metadata.title).toBe(catalog.request.meta.title);
      expect(metadata.robots).toEqual({ index: false, follow: false });
    }
  });

  it("is never stored by a browser or a proxy", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const path of ["/request", "/es/request"]) {
      const rule = rules.find((entry) => entry.source === path);
      expect(rule?.headers, path).toContainEqual({ key: "Cache-Control", value: "no-store" });
    }
  });
});

describe("preselectedCategoryId", () => {
  const categories: RequestCategory[] = [
    { id: "c1", slug: "handyman", name: "Handyman", questions: [] },
    { id: "c2", slug: "painting", name: "Painting", questions: [] },
  ];

  it("picks the service a link names, only an active one", () => {
    expect(preselectedCategoryId(categories, { service: "painting" })).toBe("c2");
    expect(preselectedCategoryId(categories, { service: "roofing" })).toBeNull();
    expect(preselectedCategoryId(categories, { service: ["handyman", "painting"] })).toBeNull();
    expect(preselectedCategoryId(categories, {})).toBeNull();
    expect(preselectedCategoryId(null, { service: "handyman" })).toBeNull();
  });
});

describe("requestFlowText", () => {
  it.each(["en", "es"] as const)(
    "in %s keeps the placeholders the browser fills",
    async (locale) => {
      const text = requestFlowText(await getT(locale));
      expect(text.progress).toMatch(/\{\{current\}\}.*\{\{total\}\}/);
      expect(text.optional).toContain("{{label}}");
      expect(text.counter).toBe("{{length}} / {{max}}");
      expect(text.waitlist.body).toContain("{{zip}}");
      expect(text.questions.range).toMatch(/\{\{min\}\}.*\{\{max\}\}/);
      for (const template of [
        text.questions.tooFew,
        text.questions.tooMany,
        text.questions.pickUpTo,
      ]) {
        expect(template).toContain("{{count}}");
      }
    },
  );
});

describe("the browser's side of the flow", () => {
  // The secrets and the API client stay on the server: a client component imports none of the
  // server modules (a type import is erased and allowed).
  const here = dirname(fileURLToPath(import.meta.url));
  const SERVER_ONLY = [
    "./actions",
    "./api-client",
    "./config",
    "./send-body",
    "./server",
    "@/lib/public-form/form-token",
    "@/lib/public-form/settings",
    "@/lib/public-form/visitor",
  ];

  it("never imports a server module", () => {
    const clientFiles = readdirSync(here).filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !file.endsWith(".test.ts") &&
        readFileSync(join(here, file), "utf8").startsWith('"use client";'),
    );
    expect(clientFiles.length).toBeGreaterThan(5);
    for (const file of clientFiles) {
      const source = readFileSync(join(here, file), "utf8");
      const imports = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)].map(
        (match) => match[1],
      );
      for (const name of imports)
        expect(SERVER_ONLY, `${file} imports ${name}`).not.toContain(name);
    }
  });
});
