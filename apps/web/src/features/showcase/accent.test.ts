import { describe, expect, it } from "vitest";

import { accentParts } from "./accent";

describe("accentParts", () => {
  it("splits a headline around its accented word", () => {
    expect(accentParts("Whatever happens at home, we <accent>fix</accent> it.")).toEqual({
      before: "Whatever happens at home, we ",
      accent: "fix",
      after: " it.",
    });
  });

  it("keeps a headline that ends with the accented word", () => {
    expect(accentParts("Pase lo que pase en casa, lo <accent>arreglamos</accent>.")).toEqual({
      before: "Pase lo que pase en casa, lo ",
      accent: "arreglamos",
      after: ".",
    });
  });

  it.each(["No marker here.", "An <accent>unclosed marker.", ""])(
    "leaves %j whole when it has no complete marker",
    (text) => {
      expect(accentParts(text)).toEqual({ before: text, accent: "", after: "" });
    },
  );

  it("splits at the first marker only", () => {
    expect(accentParts("a <accent>b</accent> c <accent>d</accent>")).toEqual({
      before: "a ",
      accent: "b",
      after: " c <accent>d</accent>",
    });
  });
});
