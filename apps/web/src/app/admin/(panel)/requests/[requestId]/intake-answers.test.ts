import { describe, expect, it } from "vitest";

import { type IntakeQuestion, intakeAnswerRows } from "./intake-answers";

const WORDS = { yes: "Yes", no: "No" };
const QUESTIONS = [
  {
    key: "floors",
    type: "integer",
    required: true,
    labels: { en: "How many floors?" },
    min: 1,
    max: 5,
  },
  {
    key: "size",
    type: "single_choice",
    required: true,
    labels: { en: "How big?", es: "¿Qué tamaño?" },
    options: [
      { value: "small", labels: { en: "Small", es: "Pequeño" } },
      { value: "large", labels: { en: "Large" } },
    ],
  },
  { key: "pets", type: "boolean", required: false, labels: { en: "Pets at home?", es: "  " } },
  { key: "notes", type: "text", required: false, labels: {}, max_length: 300 },
] as unknown as IntakeQuestion[];

describe("intakeAnswerRows (#546)", () => {
  it("names each question and option in the reader's language, else English", () => {
    const answers = { floors: 2, size: "large", pets: false, notes: "Gate code at the door" };

    expect(intakeAnswerRows(answers, QUESTIONS, "es", { yes: "Sí", no: "No" })).toEqual([
      { key: "floors", question: "How many floors?", answer: "2" },
      { key: "size", question: "¿Qué tamaño?", answer: "Large" },
      { key: "pets", question: "Pets at home?", answer: "No" },
      { key: "notes", question: "notes", answer: "Gate code at the door" },
    ]);
  });

  it("keeps what the category no longer has as it is stored", () => {
    const answers = { size: "medium", gone: ["a", "b"], pets: "maybe" };

    expect(intakeAnswerRows(answers, QUESTIONS, "en", WORDS)).toEqual([
      { key: "size", question: "How big?", answer: "medium" },
      { key: "gone", question: "gone", answer: "a, b" },
      { key: "pets", question: "Pets at home?", answer: "maybe" },
    ]);
    // A retired category: no questions at all.
    expect(intakeAnswerRows({ size: "small", pets: true }, [], "en", WORDS)).toEqual([
      { key: "size", question: "size", answer: "small" },
      { key: "pets", question: "pets", answer: "true" },
    ]);
  });
});
