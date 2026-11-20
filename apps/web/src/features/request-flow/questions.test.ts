import { describe, expect, it } from "vitest";

import { type IntakeQuestion, localized, questionError, questionErrors } from "./questions";

const labels = { en: "Label", es: "Etiqueta" };
const options = [
  { value: "a", labels: { en: "A", es: "A" } },
  { value: "b", labels: { en: "B", es: "B" } },
  { value: "c", labels: { en: "C", es: "C" } },
];

const integer: IntakeQuestion = {
  type: "integer",
  key: "rooms",
  required: true,
  labels,
  min: 1,
  max: 10,
};
const single: IntakeQuestion = {
  type: "single_choice",
  key: "kind",
  required: true,
  labels,
  options,
};
const multi: IntakeQuestion = {
  type: "multi_choice",
  key: "rooms_list",
  required: false,
  labels,
  options,
  min_selected: 0,
  max_selected: 2,
};
const text: IntakeQuestion = {
  type: "text",
  key: "notes",
  required: true,
  labels,
  max_length: 200,
};
const yesNo: IntakeQuestion = { type: "boolean", key: "pets", required: true, labels };

describe("questionError (the API's rules, as the app)", () => {
  it("an integer within its range", () => {
    expect(questionError(integer, undefined)).toEqual({ kind: "required" });
    expect(questionError({ ...integer, required: false }, undefined)).toBeNull();
    expect(questionError(integer, 1)).toBeNull();
    expect(questionError(integer, 10)).toBeNull();
    for (const answer of [0, 11, 2.5, "3"]) {
      expect(questionError(integer, answer), String(answer)).toEqual({
        kind: "range",
        min: 1,
        max: 10,
      });
    }
  });

  it("a single choice among its options", () => {
    expect(questionError(single, "b")).toBeNull();
    expect(questionError(single, "z")).toEqual({ kind: "required" });
    expect(questionError({ ...single, required: false }, undefined)).toBeNull();
  });

  it("a multiple choice between its least and its most, counting only offered picks", () => {
    expect(questionError(multi, undefined)).toBeNull();
    expect(questionError(multi, ["a", "b"])).toBeNull();
    expect(questionError(multi, ["a", "b", "c"])).toEqual({ kind: "tooMany", count: 2 });
    expect(questionError(multi, ["a", "gone", "b"])).toBeNull();
    const atLeastTwo = { ...multi, required: true, min_selected: 2, max_selected: null };
    expect(questionError(atLeastTwo, ["a"])).toEqual({ kind: "tooFew", count: 2 });
    expect(questionError(atLeastTwo, ["a", "b", "c"])).toBeNull();
    expect(questionError({ ...multi, required: true }, [])).toEqual({ kind: "tooFew", count: 1 });
  });

  it("a text with something besides spaces", () => {
    expect(questionError(text, "  ")).toEqual({ kind: "required" });
    expect(questionError(text, "Two cats")).toBeNull();
    expect(questionError({ ...text, required: false }, undefined)).toBeNull();
  });

  it("a yes/no always has an answer", () => {
    expect(questionError(yesNo, undefined)).toBeNull();
  });

  it("lists every answer that cannot go, by key", () => {
    expect(questionErrors([integer, single, yesNo], { rooms: 3 })).toEqual({
      kind: { kind: "required" },
    });
  });
});

describe("localized", () => {
  it("the page's language, else English", () => {
    expect(localized({ en: "Rooms", es: "Cuartos" }, "es")).toBe("Cuartos");
    expect(localized({ en: "Rooms" }, "es")).toBe("Rooms");
  });
});
