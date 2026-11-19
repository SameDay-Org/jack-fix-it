import i18n from "@/i18n";

import { ApiError, NetworkError } from "../../../api/errors";
import { formatMoneyExact } from "../../quotes/format";
import { earningsFailure, earningsSummary, flattenEarnings } from "../api";
import { earningDates, earningLabel, formatEarningDay, money, STATUS_TONE } from "../format";
import {
  AWAITING,
  earning,
  earningsPage,
  jobId,
  ON_HOLD,
  ON_THE_WAY,
  SUMMARY,
  ZERO,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());

const t = i18n.t.bind(i18n);
const NOW = Date.parse("2026-11-18T12:00:00Z");
const pages = (...list: ReturnType<typeof earningsPage>[]) => ({
  pages: list,
  pageParams: list.map((_, index) => (index === 0 ? undefined : `c${index}`)),
});

beforeEach(() => i18n.changeLanguage("en"));

describe("money", () => {
  it("formats the API's cents in the API's currency, cents always shown", () => {
    expect(money(12_000, "usd", "en-US")).toBe("$120.00");
    expect(money(154_000, "usd", "en-US")).toBe("$1,540.00");
    expect(money(9_050, "eur", "en-US")).toBe("€90.50");
    // The quotes keep their dollars: the currency is optional there.
    expect(formatMoneyExact(8_500, "en-US")).toBe("$85.00");
  });
});

describe("each status maps to its chip and its date", () => {
  it.each([
    ["paid", "success", "Paid", earning(1), ["Paid on Nov 12"]],
    ["on_the_way", "info", "On its way", ON_THE_WAY, ["Completed Nov 10"]],
    [
      "awaiting_confirmation",
      "neutral",
      "Awaiting confirmation",
      AWAITING,
      ["Completed Nov 10", "Usually confirmed by Nov 15"],
    ],
    ["on_hold", "warning", "Under review", ON_HOLD, ["Completed Nov 10"]],
  ] as const)("%s: a %s chip that says %s", (status, tone, chip, item, dates) => {
    expect(item.status).toBe(status);
    expect(STATUS_TONE[status]).toBe(tone);
    expect(t(`earnings.status.${status}`)).toBe(chip);
    expect(earningDates(t, item, NOW)).toEqual(dates);
  });

  it("names a confirmation day only when the API gives one", () => {
    expect(earningDates(t, { ...AWAITING, expected_by: null }, NOW)).toEqual(["Completed Nov 10"]);
  });

  it("an under-review job never reads as paid", () => {
    const label = earningLabel(t, ON_HOLD, "usd", NOW);
    expect(label).toBe("House cleaning, $25.00, Under review, Completed Nov 10");
    expect(label).not.toMatch(/paid/i);
  });

  it("a row reads as one line; a job with no category is a job", () => {
    expect(earningLabel(t, earning(1), "usd", NOW)).toBe(
      "House cleaning, $120.00, Paid, Paid on Nov 12",
    );
    expect(earningLabel(t, { ...ON_THE_WAY, category: null }, "usd", NOW)).toBe(
      "Job, $90.50, On its way, Completed Nov 10",
    );
  });

  it("writes the year only when it is not this year's", () => {
    expect(formatEarningDay("2026-11-12T15:00:00Z", NOW, "en-US")).toBe("Nov 12");
    expect(formatEarningDay("2025-12-30T15:00:00Z", NOW, "en-US")).toBe("Dec 30, 2025");
  });

  it("speaks Spanish in Spanish", async () => {
    await i18n.changeLanguage("es");
    expect(t("earnings.status.on_hold")).toBe("En revisión");
    expect(t("earnings.figure.on_hold.body")).toBe("Nuestro equipo está revisando estos trabajos.");
  });
});

describe("pages", () => {
  it("the totals are the API's summary, never added up from the loaded rows", () => {
    const data = pages(earningsPage([earning(1), ON_THE_WAY], "c1", ZERO), earningsPage([ON_HOLD]));
    expect(earningsSummary(data)).toEqual(SUMMARY);
    expect(earningsSummary(undefined)).toBeUndefined();
  });

  it("rows keep the API's order across pages, each job once", () => {
    const data = pages(
      earningsPage([earning(1), ON_THE_WAY], "c1"),
      earningsPage([ON_THE_WAY, AWAITING]),
    );
    expect(flattenEarnings(data).map((item) => item.job_id)).toEqual([
      jobId(1),
      jobId(2),
      jobId(3),
    ]);
  });
});

describe("earningsFailure", () => {
  it.each([
    ["offline", new NetworkError(false)],
    ["offline", new NetworkError(true)],
    ["busy", new ApiError(429, "rate_limited")],
    ["generic", new ApiError(500, "internal_error")],
    ["generic", new ApiError(403, "forbidden")],
    ["generic", new Error("boom")],
  ] as const)("%s for %p", (failure, error) => {
    expect(earningsFailure(error)).toBe(failure);
  });
});
