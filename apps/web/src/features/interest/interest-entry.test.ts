import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShowcasePage } from "@/features/showcase/showcase-page";
import type { Locale } from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

beforeEach(() => {
  vi.stubEnv("INTEREST_FORM_ENABLED", "true");
  vi.stubEnv("INTEREST_FORM_SECRET", "interest-secret-for-tests-0123456789ab");
  vi.stubEnv("WEB_SERVICE_KEY", "web-service-key-for-tests-0123456789");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

async function page(locale: Locale): Promise<string> {
  return decoded(renderToStaticMarkup(await ShowcasePage({ locale })));
}

describe("the showcase's interest form (#409)", () => {
  it("is not there while INTEREST_FORM_ENABLED is off: no form without its endpoint", async () => {
    for (const value of ["", "false", "1", "TRUE"]) {
      vi.stubEnv("INTEREST_FORM_ENABLED", value);
      const html = await page("en");
      expect(html, value).not.toMatch(/<form|<input|<button/);
      expect(html).not.toContain(en.showcase.interest.title);
    }
  });

  it.each([
    ["en", en, "/privacy"],
    ["es", es, "/es/privacy"],
  ] as const)(
    "in %s sits under the store notice, with its consent line",
    async (locale, catalog, privacy) => {
      const html = await page(locale);
      const soon = html.slice(html.indexOf('id="soon-title"'), html.indexOf('id="faq-title"'));
      expect(soon).toContain(catalog.showcase.interest.title);
      expect(soon).toMatch(/<label for="interest-email"[^>]*>[^<]+<\/label>/);
      expect(soon).toMatch(/<input[^>]*id="interest-email"[^>]*type="email"/);
      expect(soon).toContain(catalog.showcase.interest.consent);
      expect(soon).toContain(`href="${privacy}"`);
      // Still no store link and no external address: the app is not in the stores.
      expect(html).not.toMatch(/apps\.apple\.com|play\.google\.com/);
      expect([...html.matchAll(/href="([^"#/][^"]*)"/g)]).toEqual([]);
    },
  );

  it("fails the page without its secrets: a form that cannot be sent is never shown", async () => {
    vi.stubEnv("INTEREST_FORM_SECRET", "");
    await expect(page("en")).rejects.toThrow(/INTEREST_FORM_SECRET/);
  });
});
