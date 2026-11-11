import i18n from "@/i18n";

import { periodLabel, PREFERRED_PERIODS, withPeriod } from "../period";

const NBSP = " ";

describe("withPeriod", () => {
  afterEach(() => i18n.changeLanguage("en"));

  it("adds a named period to the day, never breaking inside either", () => {
    expect(withPeriod(i18n.t, "Tue, Nov 4", "morning")).toBe(
      `Tue,${NBSP}Nov${NBSP}4${NBSP}· Morning`,
    );
    expect(withPeriod(i18n.t, "Tue, Nov 4", "evening")).toMatch(/· Evening$/);
  });

  it("keeps a period of several words in one piece: the Spanish morning", async () => {
    await i18n.changeLanguage("es");
    expect(withPeriod(i18n.t, "jue, 12 de nov", "morning")).toBe(
      `jue,${NBSP}12${NBSP}de${NBSP}nov${NBSP}· Por${NBSP}la${NBSP}mañana`,
    );
  });

  it("leaves the day alone, still unbroken, when the period is flexible or unknown (before #237)", () => {
    expect(withPeriod(i18n.t, "Tue, Nov 4", "flexible")).toBe(`Tue,${NBSP}Nov${NBSP}4`);
    expect(withPeriod(i18n.t, "Tue, Nov 4", null)).toBe(`Tue,${NBSP}Nov${NBSP}4`);
  });

  it("lets a long day wrap at its spaces on request, never the period", () => {
    expect(withPeriod(i18n.t, "Wednesday, November 11", "afternoon", { wrapDay: true })).toBe(
      `Wednesday, November 11${NBSP}· Afternoon`,
    );
    expect(withPeriod(i18n.t, "Wednesday, November 11", null, { wrapDay: true })).toBe(
      "Wednesday, November 11",
    );
  });

  it("names every period in both languages, in the order of the day", async () => {
    expect(PREFERRED_PERIODS.map((period) => periodLabel(i18n.t, period))).toEqual([
      "Morning",
      "Afternoon",
      "Evening",
      "Flexible",
    ]);
    await i18n.changeLanguage("es");
    // "Por la mañana", since the day bubble's "Mañana" is tomorrow.
    expect(PREFERRED_PERIODS.map((period) => periodLabel(i18n.t, period))).toEqual([
      "Por la mañana",
      "Tarde",
      "Noche",
      "Flexible",
    ]);
  });
});
