import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { decoded, me, requestsTo, signIn } from "../support/support-test-helpers";
import { hoursAgo, NOW, summary } from "./disputes-test-helpers";
import DisputesLoading from "./loading";
import DisputesPage from "./page";

const LIST = "/v1/admin/disputes";
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function api(list: () => Response, { role = "agent", locale = "en" } = {}): void {
  fetchMock.mockImplementation(
    routeFetch({ "/v1/auth/me": () => me(role as "agent" | "admin", locale), [LIST]: list }),
  );
}

async function render(query: Record<string, string> = {}): Promise<string> {
  return decoded(
    renderToStaticMarkup(await DisputesPage({ searchParams: Promise.resolve(query) })),
  );
}

function listCalls(): URL[] {
  return requestsTo(fetchMock.mock.calls, LIST).map(({ url }) => url);
}

const THREE = [
  summary({
    id: "11111111-1111-4111-8111-111111111111",
    public_code: "JFX-OLD1",
    opened_at: hoursAgo(50),
  }),
  summary({
    id: "22222222-2222-4222-8222-222222222222",
    public_code: "JFX-MID2",
    opened_at: hoursAgo(30),
  }),
  summary({
    id: "33333333-3333-4333-8333-333333333333",
    public_code: "JFX-NEW3",
    opened_at: hoursAgo(3),
  }),
];

describe("disputes page", () => {
  it("asks for the open disputes by default, and the resolved ones when chosen", async () => {
    api(() => Response.json({ disputes: [] }));
    await render();
    await render({ status: "resolved" });
    await render({ status: "everything" });
    expect(listCalls().map((url) => url.searchParams.get("status"))).toEqual([
      "open",
      "resolved",
      "open",
    ]);
  });

  it("keeps the API's order, the longest waiting on top, in the table and in the cards", async () => {
    api(() => Response.json({ disputes: THREE }));
    const page = await render();
    const table = page.slice(page.indexOf("<table"), page.indexOf("</table>"));
    const cards = page.slice(page.indexOf("</table>"));
    for (const part of [table, cards]) {
      const codes = [...part.matchAll(/>(JFX-[A-Z0-9]+)</g)].map(([, code]) => code);
      expect(codes).toEqual(["JFX-OLD1", "JFX-MID2", "JFX-NEW3"]);
    }
  });

  it("colors the wait: quiet, amber after 24 h, red after 48 h, said in words too", async () => {
    api(() => Response.json({ disputes: THREE }));
    const page = await render();
    const table = page.slice(page.indexOf("<table"), page.indexOf("</table>"));
    const timers = [...table.matchAll(/data-tone="(\w+)"[^>]*>([^<]+)</g)].map(([, tone, text]) => [
      tone,
      text,
    ]);
    expect(timers).toEqual([
      ["late", "Opened 2 d ago · overdue"],
      ["warn", "Opened 30 h ago · waiting long"],
      ["calm", "Opened 3 h ago"],
    ]);
    expect(table).toMatch(/data-tone="late"[^>]*class="[^"]*bg-danger/);
    expect(table).toMatch(/data-tone="warn"[^>]*class="[^"]*bg-warning/);
  });

  it("takes its amber and red limits from the settings", async () => {
    vi.stubEnv("DISPUTE_AGE_WARN_HOURS", "2");
    vi.stubEnv("DISPUTE_AGE_LATE_HOURS", "4");
    api(() => Response.json({ disputes: [THREE[2]] }));
    expect(await render()).toContain('data-tone="warn"');
  });

  it("is a table with headers on a wide screen and cards on a phone", async () => {
    api(() => Response.json({ disputes: THREE }));
    const page = await render();
    expect(page).toMatch(/<div class="hidden [^"]*lg:block"><table/);
    expect(page.match(/<th scope="col"/g)).toHaveLength(6);
    expect(page.match(/<th scope="row"/g)).toHaveLength(3);
    expect(page).toMatch(/<ul class="[^"]*lg:hidden"/);
    expect(
      page.match(/href="\/admin\/disputes\/11111111-1111-4111-8111-111111111111"/g),
    ).toHaveLength(2);
  });

  it("shows the reason, the first names and the money from cents", async () => {
    api(() => Response.json({ disputes: [summary({ reason_code: "no_show" })] }));
    const page = await render();
    expect(page).toContain("Pro didn't show up");
    expect(page).toContain('Jamie<span class="text-gray-500"> · </span>Dan');
    expect(page).toContain("$132.50 / $100.00");
  });

  it("says when the customer's total is not on record, and when a name is missing", async () => {
    api(() =>
      Response.json({
        disputes: [summary({ customer_total_cents: null, currency: null, pro_first_name: null })],
      }),
    );
    const page = await render();
    expect(page).toContain("Not on record / $100.00");
    expect(page).toContain("No name");
  });

  it("shows how a resolved dispute was settled, and when", async () => {
    api(() =>
      Response.json({
        disputes: [
          summary({
            status: "resolved",
            resolution: "partial_release",
            resolved_at: hoursAgo(1),
            pro_release_cents: 4_550,
            customer_refund_cents: 7_220,
          }),
        ],
      }),
    );
    const page = await render({ status: "resolved" });
    expect(page).toContain(">Split<");
    expect(page).not.toContain("data-tone=");
    expect(page).toContain("Nov 18, 2026");
  });

  it("marks the chosen view", async () => {
    api(() => Response.json({ disputes: [] }));
    const page = await render({ status: "resolved" });
    const links = [...page.matchAll(/<a [^>]*>/g)].map(([tag]) => tag);
    const current = links.filter((tag) => tag.includes('aria-current="true"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/admin/disputes?status=resolved"');
  });

  it.each([
    [{}, "No open disputes."],
    [{ status: "resolved" }, "No resolved disputes yet."],
  ])("says when there is nothing in %o", async (query, text) => {
    api(() => Response.json({ disputes: [] }));
    const page = await render(query);
    expect(page).toContain(text);
    expect(page).not.toContain("<table");
  });

  it.each([500, 429])("shows an error with a retry of the same view on %s", async (status) => {
    api(() => Response.json({ error: { code: "x", message: "raw API text" } }, { status }));
    const page = await render({ status: "resolved" });
    expect(page).toMatch(/<div [^>]*role="alert"/);
    expect(page).toContain("We couldn't load the disputes.");
    expect(page).toMatch(/href="\/admin\/disputes\?status=resolved"[^>]*>Try again</);
    expect(page).not.toContain("raw API text");
  });

  it("shows an error when the API does not answer", async () => {
    api(() => {
      throw new TypeError("fetch failed");
    });
    expect(await render()).toContain("We couldn't load the disputes.");
  });

  it("speaks Spanish", async () => {
    api(() => Response.json({ disputes: THREE }), { locale: "es" });
    const page = await render();
    expect(page).toContain("Disputas");
    expect(page).toContain("Abierta hace 2 d · atrasada");
    expect(page).toContain("Trabajo sin terminar");
  });

  it("asks nothing of the disputes without a staff session", async () => {
    cookies.reset({});
    api(() => Response.json({ disputes: THREE }));
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(listCalls()).toHaveLength(0);
  });
});

describe("disputes loading state", () => {
  it("shows the title and gray rows, still under Reduce Motion", async () => {
    api(() => Response.json({ disputes: [] }));
    const page = decoded(renderToStaticMarkup(await DisputesLoading()));
    expect(page).toContain('aria-busy="true"');
    expect(page).toMatch(/<p role="status"[^>]*>Loading disputes…<\/p>/);
    expect(page.match(/motion-safe:animate-pulse/g)?.length).toBeGreaterThanOrEqual(6);
    expect(page).not.toMatch(/ animate-pulse/);
  });
});
