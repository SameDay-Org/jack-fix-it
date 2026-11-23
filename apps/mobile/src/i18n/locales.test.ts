import en from "./locales/en.json";
import es from "./locales/es.json";

function flatten(value: unknown, prefix = ""): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return { [prefix]: value };
  return Object.entries(value).reduce<Record<string, unknown>>(
    (entries, [key, child]) => ({
      ...entries,
      ...flatten(child, prefix ? `${prefix}.${key}` : key),
    }),
    {},
  );
}

describe("locale catalogs", () => {
  it("es has exactly the same keys as en", () => {
    expect(Object.keys(flatten(es)).sort()).toEqual(Object.keys(flatten(en)).sort());
  });

  it.each([
    ["en", en],
    ["es", es],
  ])("%s has no empty strings", (_, catalog) => {
    for (const text of Object.values(flatten(catalog))) {
      expect(text).toEqual(expect.stringMatching(/\S/));
    }
  });

  // #600: the app is John Got It, and the persona that speaks in the copy is John.
  it.each([
    ["en", en],
    ["es", es],
  ])('no locale value contains "Jack Fix It" (%s)', (_, catalog) => {
    const old = Object.entries(flatten(catalog)).filter(([, text]) =>
      /jack\s*fix\s*it/i.test(String(text)),
    );
    expect(old).toEqual([]);
  });

  it.each([
    ["en", en],
    ["es", es],
  ])('no locale value names the old persona "Jack" (%s)', (_, catalog) => {
    const old = Object.entries(flatten(catalog)).filter(([, text]) =>
      /\bjack\b/i.test(String(text)),
    );
    expect(old).toEqual([]);
  });

  it.each([
    ["en", en],
    ["es", es],
  ])("%s names the brand John Got It", (_, catalog) => {
    expect(catalog.brand.name).toBe("John Got It");
    expect(catalog.idCard.brand).toBe("John Got It");
  });
});
