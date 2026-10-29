import i18n from "@/i18n";

import { act } from "@testing-library/react-native";

import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { CATEGORIES } from "../../home/__tests__/helpers";
import {
  findCategory,
  requestCategoryLabel,
  requestTileProps,
  sentDay,
  statusChip,
} from "../format";

// The catalog's hook module reads the API config on import; nothing here calls the API.
jest.mock("@/api", () => ({ apiGet: jest.fn() }));

// Local calendar times: "Today" and "Yesterday" are the device's days, whatever its time zone.
const local = (month: number, day: number, hour: number, year = 2026) =>
  new Date(year, month - 1, day, hour).getTime();
const iso = (time: number) => new Date(time).toISOString();
const NOW = local(10, 28, 14);

/** Every key of docs/glossary.md "Customer-visible statuses". */
const GLOSSARY_KEYS = [
  "requestReceived",
  "reviewing",
  "findingAPro",
  "quoteReady",
  "scheduled",
  "professionalOnTheWay",
  "inProgress",
  "waitingForConfirmation",
  "completed",
  "needsAttention",
  "cancelled",
];

afterEach(async () => {
  await act(() => i18n.changeLanguage("en"));
});

describe("sentDay", () => {
  const t = i18n.t.bind(i18n);

  it("today, yesterday, then the date; the year only when it is not this one", () => {
    expect(sentDay(t, iso(local(10, 28, 0)), NOW, "en-US")).toBe("Today");
    expect(sentDay(t, iso(local(10, 27, 23)), NOW, "en-US")).toBe("Yesterday");
    expect(sentDay(t, iso(local(10, 27, 0)), NOW, "en-US")).toBe("Yesterday");
    expect(sentDay(t, iso(local(10, 26, 23)), NOW, "en-US")).toBe("Oct 26");
    expect(sentDay(t, iso(local(1, 2, 9)), NOW, "en-US")).toBe("Jan 2");
    expect(sentDay(t, iso(local(12, 30, 9, 2025)), NOW, "en-US")).toBe("Dec 30, 2025");
  });

  it("a time a little ahead of the device's clock still reads today", () => {
    expect(sentDay(t, iso(NOW + 60_000), NOW, "en-US")).toBe("Today");
  });

  it("counts calendar days across a daylight-saving change", () => {
    // Where US daylight saving applies, 2026-03-08 is 23 hours long and 2026-11-01 is 25.
    expect(sentDay(t, iso(local(3, 8, 9)), local(3, 9, 9), "en-US")).toBe("Yesterday");
    expect(sentDay(t, iso(local(11, 1, 0)), local(11, 2, 23), "en-US")).toBe("Yesterday");
    expect(sentDay(t, iso(local(10, 31, 23)), local(11, 2, 0), "en-US")).toBe("Oct 31");
  });

  it("Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    expect(sentDay(t, iso(local(10, 28, 9)), NOW, "es-US")).toBe("Hoy");
    expect(sentDay(t, iso(local(10, 27, 9)), NOW, "es-US")).toBe("Ayer");
    expect(sentDay(t, iso(local(10, 25, 9)), NOW, "es-US")).toBe("25 oct");
  });
});

describe("statusChip", () => {
  const t = i18n.t.bind(i18n);

  it("knows every glossary status, with copy in English and Spanish", () => {
    for (const key of GLOSSARY_KEYS) {
      expect(statusChip(t, `customerStatus.${key}`)).not.toBeNull();
      expect(en.customerStatus).toHaveProperty(key);
      expect(es.customerStatus).toHaveProperty(key);
    }
    expect(Object.keys(en.customerStatus).sort()).toEqual([...GLOSSARY_KEYS].sort());
  });

  it("speaks the customer's words, in a tone for what the customer has to do", async () => {
    expect(statusChip(t, "customerStatus.quoteReady")).toEqual({
      label: "Quote Ready",
      tone: "brand",
    });
    expect(statusChip(t, "customerStatus.findingAPro")).toEqual({
      label: "Finding a Pro",
      tone: "info",
    });
    expect(statusChip(t, "customerStatus.cancelled")).toEqual({
      label: "Cancelled",
      tone: "neutral",
    });
    await act(() => i18n.changeLanguage("es"));
    expect(statusChip(t, "customerStatus.quoteReady")?.label).toBe("Presupuesto listo");
  });

  it("a status this build does not know shows no chip, never the raw key", () => {
    expect(statusChip(t, "customerStatus.somethingNew")).toBeNull();
    expect(statusChip(t, "toString")).toBeNull();
  });
});

describe("the row's category", () => {
  const t = i18n.t.bind(i18n);
  const handyman = CATEGORIES[1];

  it("is the catalog's by id, named in the app's language", async () => {
    const category = findCategory(CATEGORIES, handyman?.id ?? null);
    expect(requestCategoryLabel(t, category)).toBe("Handyman");
    expect(requestTileProps(category)).toEqual({ slug: "handyman" });
  });

  it("without one, or one no longer offered: 'Request' and the other-request glyph", () => {
    for (const id of [null, "00000000-0000-4000-8000-000000000099"]) {
      const category = findCategory(CATEGORIES, id);
      expect(category).toBeUndefined();
      expect(requestCategoryLabel(t, category)).toBe("Request");
      expect(requestTileProps(category)).toEqual({ slug: "other", glyph: expect.any(Object) });
    }
  });
});
