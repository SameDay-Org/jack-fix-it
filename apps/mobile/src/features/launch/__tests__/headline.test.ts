import "@/i18n";

import i18n from "@/i18n";

import { splitHeadline } from "../headline";

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
