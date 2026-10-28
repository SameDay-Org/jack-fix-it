import i18n from "@/i18n";

import { expiryAt, msUntilExpiryChanges } from "../expiry";
import { formatDateTime, formatLocale, formatMinutes, formatMoney, formatRating } from "../format";
import { proName, quoteText } from "../quoteText";
import { NOW, quote } from "./helpers";

const MINUTE_MS = 60_000;
const t = i18n.t.bind(i18n);

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("format", () => {
  it("formats cents as USD in EN and ES", async () => {
    expect(formatMoney(18_050, "en-US")).toBe("$180.50");
    expect(formatMoney(12_000, "en-US")).toBe("$120");
    expect(formatMoney(5, "en-US")).toBe("$0.05");
    expect(formatMoney(123_456_789, "en-US")).toBe("$1,234,567.89");

    expect(formatMoney(18_050, "es")).toMatch(/^180,50\sUS\$$/);
    expect(formatMoney(12_000, "es")).toMatch(/^120\sUS\$$/);

    // The app's language picks the format when the device speaks another one.
    await i18n.changeLanguage("es");
    expect(formatLocale()).toBe("es");
    expect(formatMoney(18_050)).toMatch(/^180,50\sUS\$$/);
  });

  it("formats duration, rating and jobs (singular/plural) in EN and ES", async () => {
    expect(t("quotes.duration", { span: formatMinutes(t, 45) })).toBe("About 45 min");
    expect(t("quotes.duration", { span: formatMinutes(t, 120) })).toBe("About 2 h");
    expect(t("quotes.duration", { span: formatMinutes(t, 90) })).toBe("About 1 h 30 min");
    expect(formatRating("4.80", "en")).toBe("4.8");
    expect(formatRating(null, "en")).toBeNull();
    expect(t("quotes.jobs", { count: 1 })).toBe("1 job");
    expect(t("quotes.jobs", { count: 12 })).toBe("12 jobs");
    expect(t("quotes.jobs", { count: 0 })).toBe("0 jobs");
    expect(t("quotes.years", { count: 1 })).toBe("1 year of experience");
    expect(t("quotes.years", { count: 8 })).toBe("8 years of experience");

    await i18n.changeLanguage("es");
    expect(t("quotes.duration", { span: formatMinutes(t, 120) })).toBe("Aprox. 2 h");
    expect(t("quotes.duration", { span: formatMinutes(t, 90) })).toBe("Aprox. 1 h 30 min");
    expect(formatRating("4.80", "es")).toBe("4,8");
    expect(t("quotes.jobs", { count: 1 })).toBe("1 trabajo");
    expect(t("quotes.jobs", { count: 12 })).toBe("12 trabajos");
    expect(t("quotes.years", { count: 1 })).toBe("1 año de experiencia");
    expect(t("quotes.years", { count: 8 })).toBe("8 años de experiencia");
  });

  it("writes dates with weekday, month, day and time in the device's time zone", () => {
    const iso = "2026-10-30T15:00:00Z";
    const local = new Date(iso);

    expect(formatDateTime(iso, "en-US")).toMatch(
      /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:00\s[AP]M$/,
    );
    expect(formatDateTime(iso, "en-US")).toContain(`${local.getDate()},`);
    expect(formatDateTime(iso, "es")).toMatch(
      new RegExp(`^[a-zé]{3}, ${local.getDate()} [a-z]{3}, \\d{1,2}:00`),
    );
  });

  it("a null or blank name shows the neutral label, never an empty string", async () => {
    expect(proName(t, quote(1, { pro: { name: null } }))).toBe("Jack pro");
    expect(proName(t, quote(1, { pro: { name: "  " } }))).toBe("Jack pro");
    expect(proName(t, quote(1, { pro: { name: "María P." } }))).toBe("María P.");
    await i18n.changeLanguage("es");
    expect(proName(t, quote(1, { pro: { name: null } }))).toBe("Profesional de Jack");
  });

  it("reads a card as one sentence: pro, verified, price, start and the rest", () => {
    const text = quoteText(t, quote(1, { amount_cents: 18_050 }), "open", NOW, "en-US");

    expect(text.summary).toMatch(
      /^Pro 1\., Verified by Jack Fix It, \$180\.50, Starts .+, About 2 h, Rated 4\.8, 12 jobs, 8 years of experience, Expires in 6 h$/,
    );
    expect(quoteText(t, quote(2, { pro: { rating_avg: null } }), "open", NOW, "en-US").stats).toBe(
      "New · 12 jobs · 8 years of experience",
    );
  });
});

describe("expiry", () => {
  const expiresAt = new Date(NOW + 90 * MINUTE_MS).toISOString();

  it("counts down in whole minutes, rounded up, and expires at expires_at", () => {
    expect(expiryAt(expiresAt, NOW)).toEqual({ kind: "countdown", minutes: 90 });
    expect(expiryAt(expiresAt, NOW + 89 * MINUTE_MS + 1)).toEqual({
      kind: "countdown",
      minutes: 1,
    });
    expect(expiryAt(expiresAt, NOW + 90 * MINUTE_MS)).toEqual({ kind: "expired" });
    expect(expiryAt(new Date(NOW + 25 * 60 * MINUTE_MS).toISOString(), NOW)).toEqual({
      kind: "date",
    });
    expect(expiryAt(new Date(NOW + 24 * 60 * MINUTE_MS).toISOString(), NOW)).toEqual({
      kind: "countdown",
      minutes: 24 * 60,
    });
  });

  it("knows when the label changes next: each minute, the day boundary, never after expiry", () => {
    expect(msUntilExpiryChanges(expiresAt, NOW)).toBe(MINUTE_MS);
    expect(msUntilExpiryChanges(expiresAt, NOW + 30_000)).toBe(30_000);
    expect(msUntilExpiryChanges(expiresAt, NOW + 90 * MINUTE_MS)).toBeNull();
    const farOut = new Date(NOW + 30 * 60 * MINUTE_MS).toISOString();
    expect(msUntilExpiryChanges(farOut, NOW)).toBe(6 * 60 * MINUTE_MS);
  });
});
