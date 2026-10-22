import i18n from "@/i18n";

import { layoutLines, splitHeadline } from "../headline";

describe("splitHeadline", () => {
  it("English: words before, a spaced word after", () => {
    expect(splitHeadline((word) => `Whatever happens at home, we ${word} it.`)).toEqual({
      before: ["Whatever", "happens", "at", "home,", "we"],
      attachedBefore: "",
      attachedAfter: "",
      after: ["it."],
    });
  });

  it("Spanish: the final period stays glued to the rolling word", () => {
    expect(splitHeadline((word) => `Pase lo que pase en casa, lo ${word}.`)).toEqual({
      before: ["Pase", "lo", "que", "pase", "en", "casa,", "lo"],
      attachedBefore: "",
      attachedAfter: ".",
      after: [],
    });
  });

  it("text glued before the word is kept as well", () => {
    expect(splitHeadline((word) => `We (${word}) it`)).toEqual({
      before: ["We"],
      attachedBefore: "(",
      attachedAfter: ")",
      after: ["it"],
    });
  });

  it("works with both catalogs through i18next", () => {
    const en = splitHeadline((word) => i18n.t("launch.headline", { word, lng: "en" }));
    const es = splitHeadline((word) => i18n.t("launch.headline", { word, lng: "es" }));
    expect(en.after).toEqual(["it."]);
    expect(es.attachedAfter).toBe(".");
    expect(i18n.t("launch.words", { returnObjects: true, lng: "en" })).toEqual([
      "fix",
      "clean",
      "paint",
      "mow",
      "move",
    ]);
    expect(i18n.t("launch.words", { returnObjects: true, lng: "es" })).toHaveLength(5);
  });
});

describe("layoutLines", () => {
  const parts = splitHeadline((word) => `Whatever happens at home, we ${word} it.`);
  const WIDTHS: Record<string, number> = {
    Whatever: 145,
    happens: 131,
    at: 30,
    "home,": 95,
    we: 44,
    "it.": 31,
  };
  const measure = (slotWidth: number, maxWidth = 272) => ({
    wordWidth: (text: string) => WIDTHS[text],
    slotWidth,
    space: 9,
    maxWidth,
  });
  const texts = (lines: ReturnType<typeof layoutLines>) =>
    lines!.map((line) =>
      line.map((token) => (token.kind === "slot" ? "[word]" : token.text)).join(" "),
    );

  it("breaks like a Text with spaces would, with the slot at its widest word", () => {
    // 320 dp phone: "home, we [move] it." is 281 > 272, so "it." takes a line of its own, for every word.
    expect(texts(layoutLines(parts, measure(84)))).toEqual([
      "Whatever",
      "happens at",
      "home, we [word]",
      "it.",
    ]);
    // Had the slot been sized for "fix" alone, the lines would differ, and roll with the word.
    expect(texts(layoutLines(parts, measure(39)))).toEqual([
      "Whatever",
      "happens at",
      "home, we [word] it.",
    ]);
    // A 360 dp phone (312 dp row) keeps three lines even at the widest word.
    expect(texts(layoutLines(parts, measure(84, 312)))).toEqual([
      "Whatever happens",
      "at home, we [word]",
      "it.",
    ]);
  });

  it("is null until every width is known, and keeps glued punctuation in the slot", () => {
    expect(layoutLines(parts, { ...measure(84), wordWidth: () => undefined })).toBeNull();
    const es = splitHeadline((word) => `Pase lo que pase en casa, lo ${word}.`);
    const lines = layoutLines(es, {
      wordWidth: (text) => ({ Pase: 76, lo: 29, que: 57, pase: 76, en: 38, "casa,": 81 })[text],
      slotWidth: 170,
      space: 9,
      maxWidth: 272,
    });
    expect(texts(lines)).toEqual(["Pase lo que pase", "en casa, lo", "[word]"]);
  });
});
