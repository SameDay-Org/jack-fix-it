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

  it("leaves the day alone when the period is flexible or unknown (a request from before #237)", () => {
    expect(withPeriod(i18n.t, "Tue, Nov 4", "flexible")).toBe("Tue, Nov 4");
    expect(withPeriod(i18n.t, "Tue, Nov 4", null)).toBe("Tue, Nov 4");
  });

  it("names every period in both languages, in the order of the day", async () => {
    expect(PREFERRED_PERIODS.map((period) => periodLabel(i18n.t, period))).toEqual([
      "Morning",
      "Afternoon",
      "Evening",
      "Flexible",
    ]);
    await i18n.changeLanguage("es");
    expect(PREFERRED_PERIODS.map((period) => periodLabel(i18n.t, period))).toEqual([
      "Mañana",
      "Tarde",
      "Noche",
      "Flexible",
    ]);
  });
});
