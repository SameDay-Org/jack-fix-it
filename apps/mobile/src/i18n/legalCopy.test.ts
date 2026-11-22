import en from "./locales/en.json";
import es from "./locales/es.json";

/**
 * The legal text rule (AGENTS.md "Legal copy", docs/mvp-plan.md "Regras de texto"): until legal
 * approval the app never says that money is held, protected, released or guaranteed, never promises
 * a refund, a warranty, insurance or a license, and never tells anyone to "pay safely". "Pagamento
 * protegido" and "garantia" are internal flow names. The app describes what the customer does and
 * what the app does instead.
 *
 * Every string in both catalogs is scanned for these words. Spanish mirrors every English term
 * (`MIRRORS` proves it). A string may use one only through an entry of `EXCEPTIONS`.
 */
const FORBIDDEN: Record<"en" | "es", RegExp> = {
  en: /\b(held|hold(?:s|ing)?|escrow\w*|custod(?:y|ial)|guarantee\w*|warrant(?:y|ies)|protect(?:ed|ion|s|ing)?|refund\w*|money back|pay safely|releas(?:e|ed|es|ing)|insured|licensed)\b/giu,
  es: /(?<!\p{L})(reten\p{L}*|retien\p{L}*|retuv\p{L}*|escrow\p{L}*|fideicomis\p{L}*|custodi\p{L}*|garant\p{L}*|proteg\p{L}*|protecci[oó]n|reembols\p{L}*|reintegr\p{L}*|(?:devol|devuelv)\p{L}* (?:\p{L}+ ){0,2}dinero|paga(?:r|s)? (?:con seguridad|de (?:forma|manera) segura|seguro)|liber(?:a|á|ó|e|en|an|ad[oa]s?|ar\p{L}*|amos|aci[oó]n)|asegurad[oa]s?|licenciad[oa]s?|con licencia)(?!\p{L})/giu,
};

type Exception = {
  language: "en" | "es";
  /** The exact catalog key, never a prefix. */
  key: string;
  /** The one forbidden word the phrase holds. */
  word: string;
  /** The exact text around the word: only this is skipped, so the word stays forbidden elsewhere. */
  phrase: string;
  why: string;
};

/** The reviewed neutral uses of a forbidden word: neither is about money. */
const EXCEPTIONS: readonly Exception[] = [
  {
    language: "en",
    key: "proJobs.screen.copyHint",
    word: "hold",
    phrase: "Press and hold",
    why: "a gesture: press and hold the address",
  },
  {
    language: "en",
    key: "proJobs.photos.full",
    word: "holds",
    phrase: "the most this job holds",
    why: "how many photos a job takes, not money",
  },
];

/**
 * Where the app talks about the customer's money: the confirm sheet and the job's status line (both
 * said "Payment is released"), the pay panel and its announcement, the wallet, quotes and payouts,
 * every FAQ answer, a reported problem and how it was resolved, a cancellation's cost and where
 * its money stands, and the tip (#273). No string under these prefixes can ever become an exception.
 */
const PROMISE_KEYS = [
  "jobs.confirmSheet.",
  "jobs.support.",
  "jobs.paid.",
  "payment.",
  "paymentMethods.",
  "quotes.",
  "quoteForm.",
  "help.faq.",
  "disputes.",
  "cancellation.",
  "tips.",
] as const;

/** Each English term the rule names, and its Spanish mirrors: both matchers must catch them. */
const MIRRORS: readonly (readonly [string, readonly string[]])[] = [
  ["held", ["retenido", "retenemos", "retiene", "retuvimos"]],
  ["holding", ["retención"]],
  ["escrow", ["escrow", "fideicomiso", "custodia"]],
  ["custody", ["custodia", "custodiado"]],
  ["guarantee", ["garantía", "garantizado"]],
  ["warranty", ["garantía"]],
  ["protected", ["protegido", "protección", "protegemos"]],
  ["refund", ["reembolso", "reintegro"]],
  ["money back", ["te devolvemos tu dinero", "devolución del dinero"]],
  ["pay safely", ["paga con seguridad", "paga de forma segura"]],
  ["released", ["liberado", "se libera", "liberamos", "liberación"]],
  ["insured", ["asegurado"]],
  ["licensed", ["licenciado", "con licencia"]],
];

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

function forbiddenWords(language: "en" | "es", text: string): string[] {
  return [...text.matchAll(FORBIDDEN[language])].map((match) => match[0].toLowerCase());
}

/** Every `key: word` the rule forbids in a catalog, once each exception's phrase is skipped. */
function violations(language: "en" | "es", catalog: unknown): string[] {
  return Object.entries(flatten(catalog)).flatMap(([key, text]) => {
    const rest = EXCEPTIONS.filter((e) => e.language === language && e.key === key).reduce(
      (left, e) => left.split(e.phrase).join(" "),
      text,
    );
    return forbiddenWords(language, rest).map((word) => `${key}: ${word}`);
  });
}

/** The exceptions that sit under a promise key, as `language key`: there must be none. */
function exceptedPromises(exceptions: readonly Exception[]): string[] {
  return exceptions
    .filter(({ key }) => PROMISE_KEYS.some((prefix) => key.startsWith(prefix)))
    .map(({ language, key }) => `${language} ${key}`);
}

const CATALOGS = { en, es } as const;

describe("legal copy", () => {
  it.each(["en", "es"] as const)(
    "%s promises no held, released or guaranteed money",
    (language) => {
      expect(violations(language, CATALOGS[language])).toEqual([]);
    },
  );

  it("an exception is one reviewed phrase, still in its string, holding exactly its word", () => {
    for (const { language, key, word, phrase } of EXCEPTIONS) {
      const text = flatten(CATALOGS[language])[key];
      expect({ key, inString: text?.includes(phrase) }).toEqual({ key, inString: true });
      expect({ key, words: forbiddenWords(language, phrase) }).toEqual({ key, words: [word] });
    }
  });

  it("a customer promise key can never be an exception", () => {
    expect(exceptedPromises(EXCEPTIONS)).toEqual([]);
  });

  it("an exception under a reported problem's words fails, as under any promise key", () => {
    const sent: Exception = {
      language: "en",
      key: "disputes.sent.body",
      word: "refund",
      phrase: "a refund",
      why: "probe",
    };
    expect(exceptedPromises([...EXCEPTIONS, sent])).toEqual(["en disputes.sent.body"]);
  });

  it.each(["en", "es"] as const)("%s still has every promise key prefix", (language) => {
    const keys = Object.keys(flatten(CATALOGS[language]));
    const missing = PROMISE_KEYS.filter((prefix) => !keys.some((key) => key.startsWith(prefix)));
    expect(missing).toEqual([]);
  });

  it.each(MIRRORS)("catches %s in EN and its Spanish mirrors", (english, spanish) => {
    expect(violations("en", { probe: `Your money is ${english}.` })).not.toEqual([]);
    for (const term of spanish) {
      expect({ term, found: violations("es", { probe: `Tu pago: ${term}.` }) }).not.toEqual({
        term,
        found: [],
      });
    }
  });

  it.each([
    ["Tu pago queda en escrow.", "escrow"],
    ["Tu pago queda en fideicomiso.", "fideicomiso"],
  ])("es catches %s in payment.notAvailable", (text, word) => {
    const strings = flatten(es);
    expect(strings["payment.notAvailable"]).toBeDefined();
    expect(violations("es", { ...strings, "payment.notAvailable": text })).toEqual([
      `payment.notAvailable: ${word}`,
    ]);
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

  it("an exception skips its phrase only, not the word elsewhere in the string", () => {
    const text = "We hold your payment. Press and hold the address to copy it.";
    expect(violations("en", { "proJobs.screen.copyHint": text })).toEqual([
      "proJobs.screen.copyHint: hold",
    ]);
  });
});
