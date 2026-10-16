import { describe, expect, it } from "vitest";

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
    for (const [key, text] of Object.entries(flatten(catalog))) {
      expect(text, key).toEqual(expect.stringMatching(/\S/));
    }
  });
});
