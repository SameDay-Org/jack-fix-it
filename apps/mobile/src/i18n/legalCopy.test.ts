import en from "./locales/en.json";
import es from "./locales/es.json";

/**
 * The legal text rule (AGENTS.md "Legal copy", docs/mvp-plan.md "Regras de texto"): until legal
 * approval the app never says that money is held, protected, released or guaranteed, never promises
 * a refund, a warranty, insurance or a license, and never tells anyone to "pay safely". "Pagamento
 * protegido" and "garantia" are internal flow names. The app describes what the customer does and
 * what the app does instead.
 *
 * Every string in both catalogs is scanned for these words. A string may use one only when this
 * file names that key and that word, with why it is not a promise: a neutral status after a staff
 * decision, or a word that is not about money at all.
 */
const FORBIDDEN: Record<"en" | "es", RegExp> = {
  en: /\b(held|hold(?:s|ing)?|escrow\w*|guarantee\w*|warrant(?:y|ies)|protect(?:ed|ion|s|ing)?|refund\w*|money back|pay safely|releas(?:e|ed|es|ing)|insured|licensed)\b/giu,
  es: /(?<!\p{L})(retenid[oa]s?|reten(?:er|emos|ción)|retiene|garant\p{L}*|protegid[oa]s?|proteg(?:e|emos)|protecci[oó]n|reembols\p{L}*|liber(?:a|ado|ada|ados|adas|ar|amos)|devol\p{L}* (?:tu|el|su) dinero|paga con seguridad|asegurad[oa]s?|licenciad[oa]s?)(?!\p{L})/giu,
};

/** Key → the words it may use, and why each is not a promise. */
const ALLOWED: Record<"en" | "es", Record<string, { words: string[]; why: string }>> = {
  en: {
    "proJobs.screen.copyHint": {
      words: ["hold"],
      why: "a gesture: press and hold the address",
    },
    "proJobs.photos.full": {
      words: ["holds"],
      why: "how many photos a job takes, not money",
    },
  },
  es: {},
};

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value !== "object" || value === null) return { [prefix]: String(value) };
  return Object.entries(value).reduce<Record<string, string>>(
    (entries, [key, child]) => ({
      ...entries,
      ...flatten(child, prefix ? `${prefix}.${key}` : key),
    }),
    {},
  );
}

/** Every `key: word` the rule forbids in a catalog, minus what `ALLOWED` names for that key. */
function violations(language: "en" | "es", catalog: unknown): string[] {
  const found: string[] = [];
  for (const [key, text] of Object.entries(flatten(catalog))) {
    const allowed = ALLOWED[language][key]?.words ?? [];
    for (const match of text.matchAll(FORBIDDEN[language])) {
      const word = match[0].toLowerCase();
      if (!allowed.includes(word)) found.push(`${key}: ${word}`);
    }
  }
  return found;
}

describe("legal copy", () => {
  it.each([
    ["en", en],
    ["es", es],
  ] as const)("%s promises no held, released or guaranteed money", (language, catalog) => {
    expect(violations(language, catalog)).toEqual([]);
  });

  it.each(["en", "es"] as const)("%s allows a word only where it is still used", (language) => {
    const strings = flatten(language === "en" ? en : es);
    for (const [key, { words }] of Object.entries(ALLOWED[language])) {
      const text = strings[key] ?? "";
      const used = [...text.matchAll(FORBIDDEN[language])].map((m) => m[0].toLowerCase());
      expect({ key, words: words.filter((word) => used.includes(word)) }).toEqual({ key, words });
    }
  });

  it.each([
    ["en", "Payment is released to Dan.", "released"],
    ["en", "Your money is held until you confirm.", "held"],
    ["en", "Protected payment with a full refund guarantee.", "protected"],
    ["es", "El pago se libera a Dan.", "libera"],
    ["es", "Tu pago queda retenido y protegido, con garantía de reembolso.", "retenido"],
  ] as const)("catches %s: %s", (language, text, word) => {
    expect(violations(language, { probe: text })).toContain(`probe: ${word}`);
  });
});
