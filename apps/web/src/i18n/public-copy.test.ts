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
const PUBLIC_NAMESPACES = ["brand", "showcase", "landing"] as const;

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
 * approves the profile), and the lines that rely on that explanation. A new use is a new claim
 * for legal to read first.
 */
const VERIFIED_KEYS = [
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

function publicStrings(catalog: Record<string, unknown>): [string, string][] {
  return PUBLIC_NAMESPACES.flatMap((namespace) => strings(catalog[namespace], namespace));
}

describe("public copy", () => {
  it.each([
    ["en", en, FORBIDDEN.en],
    ["es", es, FORBIDDEN.es],
  ] as const)(
    "in %s promises no insurance, warranty, escrow, licence or refund",
    (_, catalog, words) => {
      const offenders = publicStrings(catalog).filter(([, text]) =>
        words.some((word) => word.test(text)),
      );
      expect(offenders).toEqual([]);
    },
  );

  it.each([
    ["en", en, /verif/i],
    ["es", es, /verific/i],
  ] as const)("in %s says verified only where the page explains it", (_, catalog, word) => {
    const keys = publicStrings(catalog)
      .filter(([, text]) => word.test(text))
      .map(([key]) => key)
      .sort();
    expect(keys).toEqual(VERIFIED_KEYS);
  });

  it("reads the public namespaces it names", () => {
    expect(publicStrings(en).length).toBeGreaterThan(80);
    expect(publicStrings(es).length).toBe(publicStrings(en).length);
  });
});
