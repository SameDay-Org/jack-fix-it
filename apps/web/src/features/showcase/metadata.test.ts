import { afterEach, describe, expect, it, vi } from "vitest";

import { legalMetadata, showcaseMetadata } from "./metadata";
import { siteUrl } from "@/features/site/routes";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("siteUrl", () => {
  it.each([
    ["https://jackfixit.test", "https://jackfixit.test/"],
    ["https://jackfixit.test/", "https://jackfixit.test/"],
    // Only the origin counts: a path, a query or a fragment is dropped.
    ["https://staging.jackfixit.test/app?x=1#y", "https://staging.jackfixit.test/"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000/"],
  ])("reads %s as %s", (value, origin) => {
    vi.stubEnv("SITE_URL", value);

    expect(siteUrl()?.href).toBe(origin);
  });

  it.each(["", "jackfixit.test", "not a url", "ftp://jackfixit.test", "javascript:alert(1)"])(
    "has none for %j",
    (value) => {
      vi.stubEnv("SITE_URL", value);

      expect(siteUrl()).toBeNull();
    },
  );
});

describe("showcase metadata", () => {
  it("names the page in English", async () => {
    vi.stubEnv("SITE_URL", "");

    const metadata = await showcaseMetadata("en");

    expect(metadata.title).toBe("Jack Fix It: the app for whatever happens at home");
    expect(metadata.description).toContain("Coming soon to iPhone and Android.");
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: "Jack Fix It",
      title: metadata.title,
      description: metadata.description,
      locale: "en_US",
      alternateLocale: ["es_US"],
    });
  });

  it("names the page in Spanish", async () => {
    vi.stubEnv("SITE_URL", "");

    const metadata = await showcaseMetadata("es");

    expect(metadata.title).toBe("Jack Fix It: la app para lo que pase en casa");
    expect(metadata.description).toContain("Muy pronto en iPhone y Android.");
    expect(metadata.openGraph).toMatchObject({ locale: "es_US", alternateLocale: ["en_US"] });
  });

  it.each([
    ["en", "/app"],
    ["es", "/es/app"],
  ] as const)(
    "with SITE_URL, %s points to itself and to its twin in the other language",
    async (locale, path) => {
      vi.stubEnv("SITE_URL", "https://jackfixit.test");

      const metadata = await showcaseMetadata(locale);

      expect(String(metadata.metadataBase)).toBe("https://jackfixit.test/");
      expect(metadata.alternates).toEqual({
        canonical: path,
        languages: { en: "/app", es: "/es/app", "x-default": "/app" },
      });
      expect(metadata.openGraph).toMatchObject({ url: path });
    },
  );

  it.each(["", "not a url"])(
    "without a usable SITE_URL (%j) it carries no address at all",
    async (value) => {
      vi.stubEnv("SITE_URL", value);

      const metadata = await showcaseMetadata("es");

      expect(metadata).not.toHaveProperty("metadataBase");
      expect(metadata).not.toHaveProperty("alternates");
      expect(metadata.openGraph).not.toHaveProperty("url");
    },
  );
});

describe("legal placeholder metadata", () => {
  it.each([
    ["en", "terms", "Terms of Service · Jack Fix It"],
    ["en", "privacy", "Privacy Policy · Jack Fix It"],
    ["es", "terms", "Términos de servicio · Jack Fix It"],
    ["es", "privacy", "Política de privacidad · Jack Fix It"],
  ] as const)(
    "%s %s has its title and stays out of search indexes",
    async (locale, document, title) => {
      const metadata = await legalMetadata(locale, document);

      expect(metadata.title).toBe(title);
      expect(metadata.robots).toEqual({ index: false, follow: true });
    },
  );
});
