import type { TFunction } from "i18next";

import i18n from "@/i18n";

import { deadlineText } from "../deadline";

const t = i18n.t.bind(i18n) as TFunction;

// Wed Oct 28 2026, 10:00 AM in New York (EDT), 11 PM in Tokyo.
const NOW = Date.parse("2026-10-28T14:00:00Z");
const HOUR_MS = 3_600_000;
const NEW_YORK = "America/New_York";
const TOKYO = "Asia/Tokyo";
const iso = (hours: number, from: number = NOW) => new Date(from + hours * HOUR_MS).toISOString();

// Intl puts a no-break or narrow no-break space before AM/PM; the words read the same.
const SPACES = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`, "g");
const plain = (text: string | null) => text?.replace(SPACES, " ") ?? null;
const inEnglish = (confirmBy: string | null, now = NOW, zone: string = NEW_YORK) =>
  plain(deadlineText(t, confirmBy, now, "en-US", zone));

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("deadlineText (#66)", () => {
  it("says today, tomorrow or the weekday, with the time", () => {
    expect(inEnglish(iso(3))).toBe("Confirms automatically today at 1:00 PM if you don't answer.");
    expect(inEnglish(iso(24))).toBe(
      "Confirms automatically tomorrow at 10:00 AM if you don't answer.",
    );
    expect(inEnglish(iso(48))).toBe(
      "Confirms automatically on Friday at 10:00 AM if you don't answer.",
    );
  });

  it("counts calendar days, not 24 h: late tonight is today, early tomorrow is tomorrow", () => {
    expect(inEnglish(iso(13.5))).toBe(
      "Confirms automatically today at 11:30 PM if you don't answer.",
    );
    expect(inEnglish(iso(14.5))).toBe(
      "Confirms automatically tomorrow at 12:30 AM if you don't answer.",
    );
  });

  it("reads the day and the time in the phone's time zone", () => {
    // The same instant: 7:30 PM today in New York, 8:30 AM tomorrow in Tokyo.
    const confirmBy = "2026-10-28T23:30:00Z";
    expect(inEnglish(confirmBy, NOW, NEW_YORK)).toBe(
      "Confirms automatically today at 7:30 PM if you don't answer.",
    );
    expect(inEnglish(confirmBy, NOW, TOKYO)).toBe(
      "Confirms automatically tomorrow at 8:30 AM if you don't answer.",
    );
  });

  it("keeps the day right across a daylight saving change", () => {
    // Sat Oct 31, 10 AM EDT; the clocks go back on Sunday Nov 1.
    const saturday = Date.parse("2026-10-31T14:00:00Z");
    expect(inEnglish("2026-11-02T15:00:00Z", saturday)).toBe(
      "Confirms automatically on Monday at 10:00 AM if you don't answer.",
    );
  });

  it("past the time, it confirms any moment now (the worker has not run yet)", () => {
    expect(inEnglish(iso(0))).toBe("Confirms automatically any moment now.");
    expect(inEnglish(iso(-2))).toBe("Confirms automatically any moment now.");
  });

  it("says nothing without a usable time", () => {
    expect(inEnglish(null)).toBeNull();
    expect(inEnglish("not a time")).toBeNull();
  });

  it("speaks Spanish, with the article the hour takes", async () => {
    await i18n.changeLanguage("es");
    const inSpanish = (confirmBy: string) => plain(deadlineText(t, confirmBy, NOW, "es", NEW_YORK));

    expect(inSpanish(iso(3))).toBe("Se confirma automáticamente hoy a las 13:00 si no respondes.");
    // 1:40 AM on Thursday: "a la 1:40".
    expect(inSpanish("2026-10-29T05:40:00Z")).toBe(
      "Se confirma automáticamente mañana a la 1:40 si no respondes.",
    );
    expect(inSpanish(iso(48))).toBe(
      "Se confirma automáticamente el viernes a las 10:00 si no respondes.",
    );
    expect(inSpanish(iso(-1))).toBe("Se confirmará automáticamente en cualquier momento.");
  });
});
