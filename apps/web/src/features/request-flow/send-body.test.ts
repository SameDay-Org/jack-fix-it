import { describe, expect, it } from "vitest";

import { CONSENT_VERSION } from "./config";
import { answerText, formatDay, formatPhone } from "./review-format";
import { intakeAnswersFor, type IntakeQuestion } from "./questions";
import { webRequestBody } from "./send-body";
import type { RequestDraft } from "./types";

const NOW = new Date("2026-11-19T15:00:00Z");
const DRAFT: RequestDraft = {
  zip: "33301",
  description: "Leaky faucet",
  categoryId: null,
  answers: {},
  address: { line1: "100 Las Olas Blvd", line2: " Apt 4 ", city: "Fort Lauderdale", state: "FL" },
  date: "",
  period: "evening",
  contact: { firstName: "Ana", phone: "954-555-0100", email: " Ana@Example.com " },
  locale: "en",
  utm: null,
};

describe("webRequestBody (POST /v1/web/requests, #86)", () => {
  it("is the API's body: the contact in its shape, the consent, an empty trap field", () => {
    const body = webRequestBody(DRAFT, NOW, "+1");
    expect(body).toEqual({
      description: "Leaky faucet",
      category_id: null,
      intake_answers: {},
      address: {
        line1: "100 Las Olas Blvd",
        line2: "Apt 4",
        city: "Fort Lauderdale",
        state: "FL",
        zip_code: "33301",
      },
      // No day: the time of day goes too (the visitor is flexible).
      preferred_date: null,
      preferred_period: null,
      contact: { first_name: "Ana", email: "ana@example.com", phone: "+19545550100" },
      locale: "en",
      utm: null,
      consent_version: CONSENT_VERSION,
      website: "",
    });
  });

  it("takes today in UTC and refuses yesterday", () => {
    expect(webRequestBody({ ...DRAFT, date: "2026-11-19" }, NOW, "+1")?.preferred_date).toBe(
      "2026-11-19",
    );
    expect(webRequestBody({ ...DRAFT, date: "2026-11-18" }, NOW, "+1")).toBeNull();
  });

  it.each<[string, Partial<RequestDraft> | Record<string, unknown>]>([
    ["answers without a service", { answers: { rooms: 2 } }],
    [
      "an answer key the API cannot have",
      { categoryId: "6b3c0e1d-1111-4222-8333-944455556666", answers: { "Rooms!": 2 } },
    ],
    [
      "an answer that is an object",
      { categoryId: "6b3c0e1d-1111-4222-8333-944455556666", answers: { rooms: { x: 1 } } },
    ],
    ["an unknown time of day", { date: "2099-01-01", period: "night" }],
    ["no email (the API needs it)", { contact: { ...DRAFT.contact, email: "" } }],
    ["a bad email", { contact: { ...DRAFT.contact, email: "ana@" } }],
    ["no mobile number", { contact: { ...DRAFT.contact, phone: " " } }],
    ["no first name", { contact: { ...DRAFT.contact, firstName: "" } }],
    ["a long unit line", { address: { ...DRAFT.address, line2: "a".repeat(256) } }],
    ["no address", { address: null }],
    ["no contact", { contact: "Ana" }],
  ])("refuses %s", (_, patch) => {
    expect(webRequestBody({ ...DRAFT, ...patch } as RequestDraft, NOW, "+1")).toBeNull();
  });

  it("keeps only the known utm keys, in a known language", () => {
    const body = webRequestBody(
      {
        ...DRAFT,
        locale: "pt" as RequestDraft["locale"],
        utm: { source: "google", gclid: "x" } as RequestDraft["utm"],
      },
      NOW,
      "+1",
    );
    expect(body?.locale).toBe("en");
    // toEqual, not toMatchObject: a gclid kept must fail this.
    expect(body?.utm).toEqual({ source: "google" });
  });
});

describe("intakeAnswersFor (the app's rules)", () => {
  const questions: IntakeQuestion[] = [
    { type: "boolean", key: "pets", required: false, labels: { en: "Pets?" } },
    { type: "text", key: "notes", required: false, labels: { en: "Notes" }, max_length: 50 },
    {
      type: "multi_choice",
      key: "tasks",
      required: false,
      labels: { en: "Tasks" },
      min_selected: 0,
      options: [
        { value: "tv", labels: { en: "Mount a TV" } },
        { value: "shelf", labels: { en: "Hang a shelf" } },
      ],
    },
  ];

  it("a yes/no left alone is no; blanks and gone picks are left out; nothing else goes", () => {
    expect(intakeAnswersFor(questions, { notes: "  ", tasks: ["gone"], other: "x" })).toEqual({
      pets: false,
    });
    expect(
      intakeAnswersFor(questions, { pets: true, notes: " two cats ", tasks: ["tv", "gone"] }),
    ).toEqual({
      pets: true,
      notes: "two cats",
      tasks: ["tv"],
    });
  });

  it("answerText words each kind of answer", () => {
    const words = { yes: "Yes", no: "No" };
    expect(answerText(questions[0]!, undefined, "en", words)).toBe("No");
    expect(answerText(questions[1]!, " Two cats ", "en", words)).toBe("Two cats");
    expect(answerText(questions[2]!, ["shelf", "tv"], "en", words)).toBe(
      "Mount a TV, Hang a shelf",
    );
    expect(answerText(questions[2]!, [], "en", words)).toBeNull();
  });
});

describe("review formatting", () => {
  it("shows a US number nationally and a day in the page's language, in UTC", () => {
    expect(formatPhone("+19545550100")).toBe("(954) 555-0100");
    expect(formatPhone("+44")).toBe("+44");
    expect(formatDay("2026-11-20", "en")).toBe("Friday, November 20");
    expect(formatDay("2026-11-20", "es")).toBe("viernes, 20 de noviembre");
  });
});
