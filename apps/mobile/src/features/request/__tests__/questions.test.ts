import { intakeAnswersFor, questionError, questionErrors } from "../questions";
import { QUESTIONS } from "./helpers";

describe("questionError", () => {
  it("asks for a required whole number and keeps it inside its bounds", () => {
    expect(questionError(QUESTIONS.rooms, undefined)).toEqual({ kind: "required" });
    expect(questionError(QUESTIONS.rooms, 0)).toEqual({ kind: "range", min: 1, max: 6 });
    expect(questionError(QUESTIONS.rooms, 7)).toEqual({ kind: "range", min: 1, max: 6 });
    expect(questionError(QUESTIONS.rooms, 2.5)).toEqual({ kind: "range", min: 1, max: 6 });
    expect(questionError(QUESTIONS.rooms, 1)).toBeNull();
    expect(questionError(QUESTIONS.rooms, 6)).toBeNull();
  });

  it("lets an optional number stay empty, but not out of bounds", () => {
    expect(questionError(QUESTIONS.area, undefined)).toBeNull();
    expect(questionError(QUESTIONS.area, 99)).toEqual({ kind: "range", min: 100, max: 5000 });
  });

  it("takes only one of a single choice's own options", () => {
    expect(questionError(QUESTIONS.surface, undefined)).toEqual({ kind: "required" });
    expect(questionError(QUESTIONS.surface, "roof")).toEqual({ kind: "required" });
    expect(questionError(QUESTIONS.surface, "walls")).toBeNull();
  });

  it("asks a required multi choice for at least its minimum", () => {
    expect(questionError(QUESTIONS.extras, undefined)).toEqual({ kind: "tooFew", count: 1 });
    expect(questionError(QUESTIONS.extras, [])).toEqual({ kind: "tooFew", count: 1 });
    expect(questionError(QUESTIONS.extras, ["trim"])).toBeNull();
  });

  it("does not count a pick the category no longer offers", () => {
    expect(questionError(QUESTIONS.extras, ["shutters"])).toEqual({ kind: "tooFew", count: 1 });
    expect(intakeAnswersFor([QUESTIONS.extras], { extras: ["shutters", "doors"] })).toEqual({
      extras: ["doors"],
    });
  });

  it("asks a required text for more than blanks; a switch always has an answer", () => {
    const required = { ...QUESTIONS.notes, required: true };
    expect(questionError(required, "   ")).toEqual({ kind: "required" });
    expect(questionError(required, "Navy blue")).toBeNull();
    expect(questionError(QUESTIONS.notes, undefined)).toBeNull();
    expect(questionError(QUESTIONS.furnished, undefined)).toBeNull();
  });
});

describe("questionErrors", () => {
  it("lists every question that cannot go yet, by key", () => {
    const all = Object.values(QUESTIONS);

    expect(questionErrors(all, { rooms: 9, extras: ["doors"] })).toEqual({
      rooms: { kind: "range", min: 1, max: 6 },
      surface: { kind: "required" },
    });
  });
});

describe("intakeAnswersFor", () => {
  it("keys the answers, drops blanks and strangers, and sends a switch left alone as no", () => {
    const all = Object.values(QUESTIONS);

    expect(
      intakeAnswersFor(all, {
        rooms: 3,
        surface: "walls",
        extras: ["trim", "doors"],
        notes: "  Navy blue  ",
        retired: "an answer to a question the category no longer asks",
      }),
    ).toEqual({
      rooms: 3,
      surface: "walls",
      extras: ["trim", "doors"],
      notes: "Navy blue",
      furnished: false,
    });
    expect(intakeAnswersFor(all, { notes: "   ", extras: [] })).toEqual({ furnished: false });
  });
});
