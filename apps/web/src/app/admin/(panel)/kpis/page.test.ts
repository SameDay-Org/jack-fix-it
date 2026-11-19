import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
    useRouter: () => ({ push: () => {} }),
    usePathname: () => "/admin/kpis",
  };
});

import { ACCESS_TOKEN, decoded, me, requestsTo, signIn } from "../support/support-test-helpers";
import { emptyMetrics, metrics } from "./kpis-test-helpers";
import KpisLoading from "./loading";
import KpisPage from "./page";

const METRICS = "/v1/admin/metrics";
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("BUSINESS_TIME_ZONE", "America/New_York");
  vi.stubEnv("METRICS_MAX_RANGE_DAYS", "366");
  vi.stubGlobal("fetch", fetchMock);
  // 22:30 on November 18 in New York, already the 19th in UTC.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T03:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function api(answer: () => Response, locale = "en", role: "agent" | "admin" = "agent"): void {
  fetchMock.mockImplementation(
    routeFetch({ "/v1/auth/me": () => me(role, locale), [METRICS]: answer }),
  );
}

async function render(query: Record<string, string | undefined> = {}): Promise<string> {
  return decoded(renderToStaticMarkup(await KpisPage({ searchParams: Promise.resolve(query) })));
}

function metricsRequests(): URL[] {
  return requestsTo(fetchMock.mock.calls, METRICS).map((request) => request.url);
}

function count(html: string, text: string): number {
  return html.split(text).length - 1;
}

describe("the KPI page", () => {
  it("reads the API's default range with the staff session's token, never cached", async () => {
    api(() => Response.json(metrics()));

    const html = await render();

    const [request] = requestsTo(fetchMock.mock.calls, METRICS);
    expect(request?.url.search).toBe("");
    expect(new Headers(request?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request?.init?.cache).toBe("no-store");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(">KPIs</h1>");
    expect(html).toContain("Nov 16, 2026 to Nov 18, 2026");
    expect(html).toContain("Whole days in America/New_York time.");
  });

  it.each([
    ["7", "2026-11-12"],
    ["30", "2026-10-20"],
    ["90", "2026-08-21"],
  ])("asks for the last %s days, ending today in the business time zone", async (days, from) => {
    api(() => Response.json(metrics()));

    const html = await render({ days });

    expect(metricsRequests().map((url) => url.search)).toEqual([`?from=${from}&to=2026-11-18`]);
    expect(html).toMatch(
      new RegExp(`<a aria-current="true" [^>]*href="/admin/kpis\\?days=${days}"`),
    );
    expect(count(html, 'aria-current="true"')).toBe(1);
  });

  it("works without the two settings on the web service, with the API's defaults", async () => {
    vi.stubEnv("BUSINESS_TIME_ZONE", "");
    vi.stubEnv("METRICS_MAX_RANGE_DAYS", "");
    api(() => Response.json(metrics()));

    const html = await render({ days: "7" });

    expect(metricsRequests().map((url) => url.search)).toEqual(["?from=2026-11-12&to=2026-11-18"]);
    expect(html).toContain("1 h 05 min");
    expect(await render({ from: "2025-11-17", to: "2026-11-18" })).toContain(
      en.admin.kpis.range.invalid.replace("{{max}}", "366"),
    );
  });

  it("passes a custom range on as typed", async () => {
    api(() => Response.json(metrics()));

    await render({ from: "2026-10-01", to: "2026-10-31" });

    expect(metricsRequests().map((url) => url.search)).toEqual(["?from=2026-10-01&to=2026-10-31"]);
  });

  it.each([
    { from: "2026-11-01", to: "2026-10-31" },
    { from: "2025-11-17", to: "2026-11-18" },
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-10-01" },
    { from: "<script>", to: "2026-10-31" },
  ])("explains a range it cannot read, without asking the API (%j)", async (query) => {
    api(() => Response.json(metrics()));

    const html = await render(query);

    expect(metricsRequests()).toEqual([]);
    expect(html).toContain(en.admin.kpis.range.invalid.replace("{{max}}", "366"));
    expect(html).not.toContain('role="alert"');
    // Only a real day goes back into the form.
    expect(html).not.toContain('value="<script>"');
  });

  it("explains the API's refusal of a range the same calm way", async () => {
    api(() => Response.json({ error: { code: "invalid_range" } }, { status: 422 }));

    const html = await render({ from: "2026-10-01", to: "2026-10-31" });

    expect(html).toContain(en.admin.kpis.range.invalid.replace("{{max}}", "366"));
    expect(html).not.toContain(en.admin.kpis.loadError);
  });

  it.each([
    [500, en.admin.kpis.loadError],
    [429, en.admin.kpis.rateLimited],
  ])("shows an error with a retry of the same range (%s)", async (status, message) => {
    api(() => Response.json({ error: { code: "x" } }, { status }));

    const html = await render({ days: "7" });

    expect(html).toMatch(/<div [^>]*role="alert"/);
    expect(html).toContain(message);
    expect(html).toMatch(/<a [^>]*href="\/admin\/kpis\?days=7"[^>]*>Try again<\/a>/);
    expect(html).not.toContain(en.admin.kpis.figures);
  });

  it("shows an error when the API does not answer", async () => {
    api(() => {
      throw new TypeError("fetch failed");
    });

    expect(await render()).toContain(en.admin.kpis.loadError);
  });

  it("shows every card with its value, its parts and how it is calculated", async () => {
    api(() => Response.json(metrics()));

    const html = await render();

    expect(html.match(/<h3 id="kpi-/g)).toHaveLength(10);
    for (const text of ["1 h 05 min", "Median 12 min", "77.5%", "31 of 40", "12 of 40", "4.62"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("$1,092.50");
    expect(count(html, "<summary")).toBe(11); // ten cards and the table
    expect(count(html, en.admin.kpis.howCalculated)).toBe(10);
    for (const text of Object.values(en.admin.kpis.formula)) expect(html).toContain(text);
  });

  it("says No data yet for every figure the API gives as null, never 0%", async () => {
    const empty = emptyMetrics();
    // Something happened (so the page is not empty), but nothing any figure can count.
    api(() => Response.json({ ...empty, series: metrics().series }));

    const html = await render();

    expect(count(html, en.admin.kpis.noData)).toBe(8);
    expect(html).not.toMatch(/>0%<|0 of 0/);
  });

  it("marks revenue as before refunds while the API has not netted them", async () => {
    api(() => Response.json(metrics({ refunds_netted: false })));
    // The help line under the value (the formula text says the same in its own words).
    const help = `<p class="text-sm text-gray-500">${en.admin.kpis.beforeRefundsHelp}</p>`;
    let html = await render();
    expect(html).toContain(`>${en.admin.kpis.beforeRefunds}</span>`);
    expect(html).toContain(help);

    api(() => Response.json(metrics({ refunds_netted: true })));
    html = await render();
    expect(html).not.toContain(en.admin.kpis.beforeRefunds);
    expect(html).not.toContain(help);
  });

  it("puts the series in a table with the same numbers as the charts", async () => {
    api(() => Response.json(metrics()));

    const html = await render();

    const body = /<tbody>(.*?)<\/tbody>/.exec(html)?.[1] ?? "";
    const rows = [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((row) =>
      [...row[1]!.matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((cell) => cell[1]),
    );
    expect(rows).toEqual([
      ["Nov 16, 2026", "14", "3", "$480.00"],
      ["Nov 17, 2026", "12", "5", "$612.50"],
      ["Nov 18, 2026", "14", "4", "$0.00"],
    ]);
    expect(html).toContain("<caption");
    expect(html).toMatch(/<th scope="col"[^>]*>Day<\/th>/);
    expect(html).toContain(en.admin.kpis.series.showTable);
    expect(html).toContain(`aria-label="${en.admin.kpis.series.activity}"`);
    expect(html).toContain(`aria-label="${en.admin.kpis.series.gmv}"`);
  });

  it("says so when nothing happened in the range, with no cards or charts", async () => {
    api(() => Response.json(emptyMetrics()));

    const html = await render();

    expect(html).toContain(en.admin.kpis.empty);
    expect(html).not.toContain(en.admin.kpis.figures);
    expect(html).not.toContain("<table");
  });

  it("speaks Spanish to a Spanish-speaking staff member", async () => {
    api(() => Response.json(metrics()), "es");

    const html = await render({ days: "30" });

    expect(html).toContain(">Indicadores</h1>");
    for (const text of [
      es.admin.kpis.range.presets[30],
      "31 de 40",
      es.admin.kpis.formula.revenue_net_of_refunds,
      es.admin.kpis.howCalculated,
      es.admin.kpis.formula.gmv,
      es.admin.kpis.series.showTable,
      "Días completos en la hora de America/New_York.",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain(en.admin.kpis.noData);
  });

  it("asks nothing of the metrics without a staff session", async () => {
    api(() => Response.json(metrics()));
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me("customer") }));

    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(metricsRequests()).toEqual([]);
  });
});

describe("the KPI page while it loads", () => {
  it.each([
    ["en", en.admin.kpis.loading],
    ["es", es.admin.kpis.loading],
  ])("shows its frame in gray blocks, and says so (%s)", async (locale, loading) => {
    api(() => Response.json(metrics()), locale);

    const html = decoded(renderToStaticMarkup(await KpisLoading()));

    expect(html).toMatch(/^<div aria-busy="true"/);
    expect(html).toContain(`<p role="status" class="text-sm text-gray-500">${loading}</p>`);
    expect(html.match(/<li /g)).toHaveLength(10);
    expect(html).toContain("motion-safe:animate-pulse");
    expect(metricsRequests()).toEqual([]);
  });
});
