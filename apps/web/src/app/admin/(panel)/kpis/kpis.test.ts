import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import { getT } from "@/i18n/server";

import {
  businessTimeZone,
  DEFAULT_BUSINESS_TIME_ZONE,
  DEFAULT_METRICS_MAX_RANGE_DAYS,
  metricsMaxRangeDays,
} from "./config";
import {
  durationParts,
  formatDuration,
  formatPercent,
  formatRating,
  isEmpty,
  metricCards,
  type MetricFormula,
} from "./kpis";
import { emptyMetrics, metrics } from "./kpis-test-helpers";
import { axisTicks } from "./series-chart";

const here = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the KPI figures as text", () => {
  it.each([
    [12, "12 min"],
    [12.4, "12 min"],
    [59.6, "1 h 00 min"],
    [65, "1 h 05 min"],
    [125.2, "2 h 05 min"],
    [1500, "25 h 00 min"],
    [0.4, "< 1 min"],
  ])("writes %s minutes as %s", async (minutes, text) => {
    expect(formatDuration(minutes, await getT("en"))).toBe(text);
    expect(formatDuration(minutes, await getT("es"))).toBe(text);
  });

  it("splits a duration into whole hours and minutes", () => {
    expect(durationParts(65.4)).toEqual({ hours: 1, minutes: 5 });
    expect(durationParts(0.49)).toBeNull();
  });

  it("writes a share as a percentage, one decimal at most", () => {
    expect(formatPercent(0.37, "en")).toBe("37%");
    expect(formatPercent(0.0833, "en")).toBe("8.3%");
    expect(formatPercent(0.025, "en")).toBe("2.5%");
    expect(formatPercent(1, "en")).toBe("100%");
    expect(formatPercent(0.37, "es")).toMatch(/^37\s%$/);
  });

  it("writes a rating with one or two decimals", () => {
    expect(formatRating(4.8, "en")).toBe("4.8");
    expect(formatRating(4.62, "en")).toBe("4.62");
    expect(formatRating(5, "en")).toBe("5.0");
    expect(formatRating(4.62, "es")).toBe("4,62");
  });
});

describe("the KPI cards", () => {
  it("are the plan's ten figures, in order, each with its formula", async () => {
    const cards = metricCards(metrics(), "en", await getT("en"));
    expect(cards.map((card) => [card.title, card.formula])).toEqual([
      ["First response", "first_response_minutes"],
      ["Contact rate", "contact_rate"],
      ["Lead to job", "lead_to_job"],
      ["Completion rate", "completion_rate"],
      ["Customer rating", "customer_rating"],
      ["Pro rating", "pro_rating"],
      ["Dispute rate", "dispute_rate"],
      ["Repeat rate", "repeat_rate"],
      ["GMV", "gmv"],
      ["Revenue", "revenue_net_of_refunds"],
    ]);
  });

  it("show each ratio with its numerator and denominator", async () => {
    const cards = metricCards(metrics(), "en", await getT("en"));
    const figure = (key: string) => cards.find((card) => card.key === key)?.figure;
    expect(figure("contactRate")).toEqual({ value: "77.5%", details: ["31 of 40"] });
    expect(figure("leadToJob")).toEqual({ value: "30%", details: ["12 of 40"] });
    expect(figure("disputeRate")).toEqual({ value: "8.3%", details: ["1 of 12"] });
    expect(figure("firstResponse")).toEqual({
      value: "1 h 05 min",
      details: ["Median 12 min", "Requests counted: 31"],
    });
    expect(figure("proRating")).toEqual({
      value: "4.62",
      details: ["out of 5", "Reviews counted: 9"],
    });
    const es = metricCards(metrics(), "es", await getT("es"));
    expect(es.find((card) => card.key === "contactRate")?.figure?.details).toEqual(["31 de 40"]);
  });

  it("have no value, never 0, for every figure the API gives as null", async () => {
    const cards = metricCards(emptyMetrics(), "en", await getT("en"));
    const withoutValue = cards.filter((card) => card.figure === null).map((card) => card.key);
    expect(withoutValue).toEqual([
      "firstResponse",
      "contactRate",
      "leadToJob",
      "completionRate",
      "customerRating",
      "proRating",
      "disputeRate",
      "repeatRate",
    ]);
  });

  it("show money from cents with the panel's money format", async () => {
    const cards = metricCards(metrics(), "en", await getT("en"));
    expect(cards.find((card) => card.key === "gmv")?.figure?.value).toBe("$1,092.50");
    expect(cards.find((card) => card.key === "revenue")?.figure?.value).toBe("$163.88");
    const es = metricCards(metrics(), "es", await getT("es"));
    expect(es.find((card) => card.key === "gmv")?.figure?.value).toMatch(/^1092,50\sUS\$$/);
  });

  it("mark revenue as before refunds only while the API says refunds are not netted", async () => {
    const t = await getT("en");
    const flag = (refunds_netted: boolean) =>
      metricCards(metrics({ refunds_netted }), "en", t).filter((card) => card.beforeRefunds);
    expect(flag(false).map((card) => card.key)).toEqual(["revenue"]);
    expect(flag(true)).toEqual([]);
  });

  it("call a range empty only when nothing at all happened in it", () => {
    expect(isEmpty(emptyMetrics())).toBe(true);
    expect(isEmpty(metrics())).toBe(false);
    const oneRequest = emptyMetrics();
    oneRequest.series[1]!.requests_created = 1;
    expect(isEmpty(oneRequest)).toBe(false);
  });
});

describe("the KPI copy", () => {
  const FORMULAS: MetricFormula[] = [
    "first_response_minutes",
    "contact_rate",
    "lead_to_job",
    "completion_rate",
    "customer_rating",
    "pro_rating",
    "dispute_rate",
    "repeat_rate",
    "gmv",
    "revenue_net_of_refunds",
  ];

  it.each([
    ["en", en],
    ["es", es],
  ] as const)("in %s explains every formula the API names", (_, catalog) => {
    expect(Object.keys(catalog.admin.kpis.formula).sort()).toEqual([...FORMULAS].sort());
    for (const text of Object.values(catalog.admin.kpis.formula))
      expect(text.length).toBeGreaterThan(40);
  });

  it("does not print the take rate: it is the API's setting", () => {
    for (const catalog of [en, es]) {
      expect(JSON.stringify(catalog.admin.kpis)).not.toMatch(/\d+\s?%/);
    }
  });

  // The panel is internal, but its words stay neutral: no promise of insurance, warranty,
  // escrow, a licence or a guarantee. "Refund" appears only where revenue says how refunds
  // count in it.
  const PROMISES = {
    en: /escrow|guarant|\binsur|licens|warrant|protect|money back|pay safely/i,
    es: /garant|asegurad|\bseguro (de|contra)\b|licencia|protegid|protecci[oó]n|devoluci[oó]n del dinero/i,
  };
  const REFUND = { en: /refund/i, es: /reembols/i };
  const REFUND_KEYS = [
    "beforeRefunds",
    "beforeRefundsHelp",
    "formula.completion_rate",
    "formula.revenue_net_of_refunds",
  ];

  function strings(value: unknown, prefix = ""): [string, string][] {
    if (typeof value === "string") return [[prefix, value]];
    return Object.entries(value as object).flatMap(([key, child]) =>
      strings(child, prefix ? `${prefix}.${key}` : key),
    );
  }

  it.each([
    ["en", en],
    ["es", es],
  ] as const)("in %s promises nothing and names refunds only for revenue", (locale, catalog) => {
    for (const [key, text] of strings(catalog.admin.kpis)) {
      expect(text, key).not.toMatch(PROMISES[locale]);
      if (REFUND[locale].test(text)) expect(REFUND_KEYS, key).toContain(key);
    }
  });
});

describe("the KPI settings", () => {
  it("read the business time zone and the longest range from the environment", () => {
    vi.stubEnv("BUSINESS_TIME_ZONE", "America/Chicago");
    vi.stubEnv("METRICS_MAX_RANGE_DAYS", "120");
    expect(businessTimeZone()).toBe("America/Chicago");
    expect(metricsMaxRangeDays()).toBe(120);
  });

  it.each(["", "Mars/Olympus", "not a zone"])(
    "fall back to the API's time zone for %j: a missing variable breaks nothing",
    (zone) => {
      vi.stubEnv("BUSINESS_TIME_ZONE", zone);
      expect(businessTimeZone()).toBe(DEFAULT_BUSINESS_TIME_ZONE);
    },
  );

  it.each(["", "0", "-3", "1.5", "lots"])("fall back to the API's longest range for %j", (days) => {
    vi.stubEnv("METRICS_MAX_RANGE_DAYS", days);
    expect(metricsMaxRangeDays()).toBe(DEFAULT_METRICS_MAX_RANGE_DAYS);
  });

  it("default to exactly the API's own defaults", () => {
    const api = readFileSync(join(here, "../../../../../../api/app/config.py"), "utf8");
    const zone = /business_time_zone: str = Field\(\s*default="([^"]+)"/.exec(api)?.[1];
    const days = /metrics_max_range_days: int = Field\(default=(\d+)/.exec(api)?.[1];
    expect(zone).toBe(DEFAULT_BUSINESS_TIME_ZONE);
    expect(Number(days)).toBe(DEFAULT_METRICS_MAX_RANGE_DAYS);
  });
});

describe("the chart's axis", () => {
  it("steps by round numbers up to the highest value", () => {
    expect(axisTicks(14, "count")).toEqual([0, 5, 10, 15]);
    expect(axisTicks(0, "count")).toEqual([0, 1]);
    expect(axisTicks(3, "count")).toEqual([0, 1, 2, 3]);
    expect(axisTicks(61_250, "money")).toEqual([0, 20_000, 40_000, 60_000, 80_000]);
    expect(axisTicks(0, "money")).toEqual([0, 100]);
  });
});
