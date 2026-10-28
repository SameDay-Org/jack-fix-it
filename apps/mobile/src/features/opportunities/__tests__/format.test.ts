import i18n from "@/i18n";

import { categoryLabel, formatDay, locationLabel, sentAgo } from "../format";
import { NOW, PAINTING } from "./helpers";

const t = i18n.t.bind(i18n);
const MINUTE_MS = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatDay", () => {
  it("reads a calendar day as a local date, so it never slips to the evening before", () => {
    expect(formatDay("2026-10-30", "en-US")).toBe("Fri, Oct 30");
    expect(formatDay("2026-01-01", "en-US")).toBe("Thu, Jan 1");
    expect(formatDay("2026-10-30", "es")).toBe("vie, 30 oct");
  });

  it("hands back anything that is not a calendar day", () => {
    expect(formatDay("soon", "en-US")).toBe("soon");
  });
});

describe("sentAgo", () => {
  it("counts minutes, hours and days, then shows the date", () => {
    expect(sentAgo(t, ago(20_000), NOW, "en-US")).toBe("just now");
    expect(sentAgo(t, ago(MINUTE_MS), NOW, "en-US")).toBe("1 min ago");
    expect(sentAgo(t, ago(59 * MINUTE_MS), NOW, "en-US")).toBe("59 min ago");
    expect(sentAgo(t, ago(60 * MINUTE_MS), NOW, "en-US")).toBe("1 h ago");
    expect(sentAgo(t, ago(23 * 60 * MINUTE_MS), NOW, "en-US")).toBe("23 h ago");
    expect(sentAgo(t, ago(24 * 60 * MINUTE_MS), NOW, "en-US")).toBe("1 day ago");
    expect(sentAgo(t, ago(6 * 24 * 60 * MINUTE_MS), NOW, "en-US")).toBe("6 days ago");
    expect(sentAgo(t, ago(7 * 24 * 60 * MINUTE_MS), NOW, "en-US")).toBe("on Oct 21");
  });

  it("never counts backwards for a clock slightly ahead of the server", () => {
    expect(sentAgo(t, new Date(NOW + 5_000).toISOString(), NOW, "en-US")).toBe("just now");
  });
});

describe("labels", () => {
  it("names the category in the app's language, or Other request without one", async () => {
    expect(categoryLabel(t, PAINTING)).toBe("Painting");
    expect(categoryLabel(t, null)).toBe("Other request");
    expect(categoryLabel(t, { ...PAINTING, names: { fr: "Peinture" } })).toBe("painting");

    await i18n.changeLanguage("es");
    try {
      expect(categoryLabel(t, PAINTING)).toBe("Pintura");
      expect(categoryLabel(t, { ...PAINTING, names: { en: "Painting" } })).toBe("Painting");
      expect(categoryLabel(t, null)).toBe("Otra solicitud");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("shows the city and the ZIP, or the ZIP alone when the area is gone", () => {
    expect(locationLabel({ zip_code: "33301", city: "Fort Lauderdale" })).toBe(
      "Fort Lauderdale 33301",
    );
    expect(locationLabel({ zip_code: "33010", city: null })).toBe("33010");
  });
});
