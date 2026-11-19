import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import en from "./locales/en.json";
import es from "./locales/es.json";

/**
 * The legal text rules for public copy (docs/mvp-plan.md, "Regras de texto"): until the legal
 * texts are approved, the pages for customers promise no insurance, no labour warranty, no
 * escrow (money held until the customer confirms), no licence in every category and no
 * guaranteed refund. These are the words that make those promises, in each language.
 *
 * Only the public namespaces are read: the staff panel (`admin`) names things like "Held by" or
 * "Insurance" (a document type) as what they are, not as promises.
 */
const PUBLIC_NAMESPACES = ["brand", "site", "showcase", "landing", "forPros", "seo"] as const;

const FORBIDDEN: Record<"en" | "es", RegExp[]> = {
  en: [
    /\bheld\b/i,
    /\bhold(s|ing)?\b/i,
    /escrow/i,
    /guarant/i,
    /\binsur/i,
    /licens/i,
    /protect/i,
    /warrant/i,
    /refund/i,
    /pay safely/i,
    /safe payment/i,
    /money back/i,
  ],
  es: [
    /retenid|retenci[oó]n|\bretiene/i,
    /garant/i,
    /asegurad/i,
    /\bseguro (de|contra)\b/i,
    /licencia/i,
    /protegid|protecci[oó]n/i,
    /reembols/i,
    /devoluci[oó]n del dinero/i,
    /paga con seguridad|pago seguro/i,
    /tranquilidad/i,
  ],
};

/**
 * Where "verified" may appear: the FAQ explains it (our team reviews each pro's documents and
 * approves the profile), the lines that rely on that explanation, and the landing's badge in the
 * plan's approved wording ("Verified information where applicable"). A new use is a new claim
 * for legal to read first.
 */
const VERIFIED_KEYS = [
  "landing.hero.badges.verified",
  "showcase.faq.items.verified.answer",
  "showcase.faq.items.verified.question",
  "showcase.features.quotes.body",
  "showcase.hero.beats.quotes.body",
  "showcase.hero.body",
  "showcase.meta.description",
];

function strings(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, prefix ? `${prefix}.${key}` : key),
  );
}

type Catalog = Record<string, unknown>;
type Language = keyof typeof FORBIDDEN;

const CATALOGS: Record<Language, Catalog> = { en, es };
const VERIFIED: Record<Language, RegExp> = { en: /verif/i, es: /verific/i };

function publicStrings(catalog: Catalog): [string, string][] {
  return PUBLIC_NAMESPACES.flatMap((namespace) => strings(catalog[namespace], namespace));
}

/** The public keys whose text makes a promise the legal text rules forbid. */
function legalOffenders(catalog: Catalog, language: Language): string[] {
  return publicStrings(catalog)
    .filter(([, text]) => FORBIDDEN[language].some((word) => word.test(text)))
    .map(([key]) => key);
}

/** The public keys whose text says "verified", sorted. */
function verifiedKeys(catalog: Catalog, language: Language): string[] {
  return publicStrings(catalog)
    .filter(([, text]) => VERIFIED[language].test(text))
    .map(([key]) => key)
    .sort();
}

/** A copy of the catalog with one existing string replaced. */
function withText(catalog: Catalog, key: string, text: string): Catalog {
  const copy = structuredClone(catalog);
  const path = key.split(".");
  const last = path.pop()!;
  let node = copy;
  for (const part of path) node = node[part] as Catalog;
  expect(typeof node[last], key).toBe("string");
  node[last] = text;
  return copy;
}

describe("public copy", () => {
  it.each(["en", "es"] as const)(
    "in %s promises no insurance, warranty, escrow, licence or refund",
    (language) => {
      expect(legalOffenders(CATALOGS[language], language)).toEqual([]);
    },
  );

  it.each(["en", "es"] as const)(
    "in %s says verified only where the page explains it",
    (language) => {
      expect(verifiedKeys(CATALOGS[language], language)).toEqual(VERIFIED_KEYS);
    },
  );

  it("reads the public namespaces it names", () => {
    expect(publicStrings(en).length).toBeGreaterThan(80);
    expect(publicStrings(es).length).toBe(publicStrings(en).length);
  });

  // A service's page (#87) shows the API's own text: the categories' names, questions, choices
  // and their descriptions. The shipped catalog is held to the same rules.
  it.each(["en", "es"] as const)(
    "in %s holds the shipped categories' text shown on the service pages to the same rules",
    (language) => {
      const here = dirname(fileURLToPath(import.meta.url));
      const seed: unknown = JSON.parse(
        readFileSync(join(here, "../../../api/app/modules/categories/seed_data.json"), "utf8"),
      );
      const texts = shownCatalogText(seed, language);

      expect(texts.length).toBeGreaterThan(30);
      const offenders = texts.filter((text) =>
        [...FORBIDDEN[language], VERIFIED[language]].some((word) => word.test(text)),
      );
      expect(offenders).toEqual([]);
    },
  );
});

/** The texts a service page shows from the catalog: names, question labels, choices. */
function shownCatalogText(value: unknown, language: Language): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => shownCatalogText(item, language));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([child, inner]) => {
    if (["names", "labels", "description"].includes(child) && inner && typeof inner === "object") {
      const text = (inner as Record<string, unknown>)[language];
      return typeof text === "string" ? [text] : [];
    }
    return shownCatalogText(inner, language);
  });
}

describe("the public copy policy", () => {
  it.each([
    ["en", "Protected payment"],
    ["en", "Pay safely in the app"],
    ["es", "Protección de tu pago"],
    ["es", "Pago con garantía"],
  ] as const)("in %s catches a payment promise on the landing: %s", (language, claim) => {
    const catalog = withText(CATALOGS[language], "landing.hero.badges.payment", claim);
    expect(legalOffenders(catalog, language)).toEqual(["landing.hero.badges.payment"]);
  });

  it.each([
    ["en", "Verified pros"],
    ["es", "Profesionales verificados"],
  ] as const)("in %s catches a new verified claim on the landing: %s", (language, claim) => {
    const catalog = withText(CATALOGS[language], "landing.hero.badges.scheduling", claim);
    expect(verifiedKeys(catalog, language)).toEqual(
      [...VERIFIED_KEYS, "landing.hero.badges.scheduling"].sort(),
    );
  });
});
