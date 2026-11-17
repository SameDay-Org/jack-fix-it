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
    useRouter: () => ({ refresh: () => {} }),
  };
});

import { ACCESS_TOKEN, decoded, me, requestsTo, signIn } from "../support/support-test-helpers";
import QueuePage from "./page";
import {
  AGENT_ID,
  CATEGORY_ID,
  item,
  NOW,
  OTHER_REQUEST_ID,
  REQUEST_ID,
  summary,
} from "./queue-test-helpers";

const LIST = "/v1/admin/requests";
const SUMMARY = "/v1/admin/requests/summary";
const CATEGORIES = "/v1/categories";
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
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

const CATEGORY_LIST = [
  {
    id: CATEGORY_ID,
    slug: "plumbing",
    names: { en: "Plumbing", es: "Plomería" },
    icon: null,
    requires_license: false,
    intake_questions: [],
  },
];

function api(
  list: () => Response,
  options: { locale?: string; role?: "agent" | "customer"; counts?: () => Response } = {},
): void {
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": () => me(options.role ?? "agent", options.locale ?? "en"),
      [LIST]: list,
      [SUMMARY]: options.counts ?? (() => Response.json(summary())),
      [CATEGORIES]: () => Response.json(CATEGORY_LIST),
    }),
  );
}

function pageOf(items: unknown[], next_cursor: string | null = null): Response {
  return Response.json({ items, next_cursor });
}

async function render(query: Record<string, string | string[]> = {}): Promise<string> {
  return decoded(renderToStaticMarkup(await QueuePage({ searchParams: Promise.resolve(query) })));
}

function listRequest(): { url: URL; init: RequestInit | undefined } {
  const [request] = requestsTo(fetchMock.mock.calls, LIST);
  if (!request) throw new Error("the list was not requested");
  return request;
}

function text(markup: string): string {
  return markup.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");
}

describe("operations queue page", () => {
  it("lists the new requests with each tab's count and the first-contact timer", async () => {
    api(() =>
      pageOf([
        // Two of its five minutes are gone: calm, three left.
        item(),
        // Past its time by ninety seconds, flagged urgent, and somebody holds it.
        item({
          id: OTHER_REQUEST_ID,
          public_code: "JF-000182",
          customer_name: null,
          category: null,
          urgency: "high",
          created_at: "2026-11-07T14:23:30Z",
          first_contact_due_at: "2026-11-07T14:28:30Z",
          assigned_agent: { id: AGENT_ID, name: "Eva" },
        }),
      ]),
    );

    const page = await render();

    const { url, init } = listRequest();
    expect(url.search).toBe("?bucket=new");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init?.cache).toBe("no-store");
    const words = text(page);
    for (const part of ["JF-000181", "Ana P.", "Plumbing · 33301", "Received", "2 min", "Nobody"]) {
      expect(words).toContain(part);
    }
    for (const part of ["JF-000182", "No name on file", "Unclassified", "Urgent", "Eva", "6 min"]) {
      expect(words).toContain(part);
    }
    expect(page).toMatch(/data-tone="calm"[^>]*>3:00 left</);
    expect(page).toMatch(/data-tone="late"[^>]*>1:30 late</);
    expect(page).toContain(`href="/admin/requests/${REQUEST_ID}"`);
    expect(page).toContain(`href="/admin/requests/${OTHER_REQUEST_ID}"`);
    // The tabs in the order the BDC works them, each with its count; "Mine" has none.
    const tabs = [...page.matchAll(/<a [^>]*href="(\/admin\/queue[^"/]*)"[^>]*>(.*?)<\/a>/g)]
      .map(([tag, href, label]) => ({
        href,
        text: text(label ?? "").trim(),
        current: tag.includes('aria-current="true"'),
      }))
      .filter((tab) => tab.text !== "");
    expect(tabs).toEqual([
      { href: "/admin/queue", text: "New 7", current: true },
      { href: "/admin/queue?tab=urgent", text: "Urgent 4", current: false },
      { href: "/admin/queue?tab=waiting_customer", text: "Waiting on customer 2", current: false },
      { href: "/admin/queue?tab=waiting_pro", text: "Waiting on pro 3", current: false },
      { href: "/admin/queue?tab=quote_ready", text: "Quote ready 5", current: false },
      { href: "/admin/queue?tab=scheduled_today", text: "Scheduled today 6", current: false },
      { href: "/admin/queue?tab=problems", text: "Problems 1", current: false },
      { href: "/admin/queue?tab=mine", text: "Mine", current: false },
      { href: "/admin/queue?tab=all", text: "All 40", current: false },
    ]);
    expect(page).not.toContain("More requests");
    expect(page).not.toContain(ACCESS_TOKEN);
  });

  it("shows the amber timer in the second half, and no timer once contacted or dispatched", async () => {
    api(() =>
      pageOf([
        item({ created_at: "2026-11-07T14:27:00Z", first_contact_due_at: "2026-11-07T14:32:00Z" }),
        item({ id: OTHER_REQUEST_ID, first_contact_at: "2026-11-07T14:29:00Z" }),
        item({ id: CATEGORY_ID, status: "finding_pro", bucket: "waiting_pro" }),
      ]),
    );

    const page = await render({ tab: "all" });

    expect(page.match(/data-tone=/g)).toHaveLength(1);
    expect(page).toMatch(/data-tone="soon"[^>]*>2:00 left</);
    expect(text(page)).toContain("Contacted Nov 7, 2026, 2:29 PM UTC");
    expect(text(page)).toContain("Not needed");
    // Where the buckets are mixed, a row names its own.
    expect(text(page)).toContain("Finding a pro Waiting on pro");
  });

  it.each([
    [{ tab: "urgent" }, "?bucket=urgent"],
    [{ tab: "mine" }, "?bucket=all&assigned=me"],
    [{ tab: "mine", assigned: "unassigned" }, "?bucket=all&assigned=me"],
    [{ tab: "all", cursor: "abc-123" }, "?bucket=all&cursor=abc-123"],
    [{ tab: "other" }, "?bucket=new"],
    [
      { tab: "all", status: "reviewing", category_id: CATEGORY_ID, zip: "33301", q: "JF-18" },
      `?bucket=all&status=reviewing&category_id=${CATEGORY_ID}&zip=33301&q=JF-18`,
    ],
    [{ status: "paid", zip: "3330", q: "JF-%", assigned: "them" }, "?bucket=new"],
    [{ assigned: "unassigned" }, "?bucket=new&assigned=unassigned"],
  ])("asks the API for the tab and filters in the URL (%j)", async (query, search) => {
    api(() => pageOf([]));

    await render(query);

    expect(listRequest().url.search).toBe(search);
  });

  it("keeps the filters in the form, the tabs and the paging links", async () => {
    api(() => pageOf([item()], "next/cur+sor"));

    const page = await render({ tab: "urgent", zip: "33301", q: "JF-18", cursor: "abc-123" });

    expect(page).toContain('<input type="hidden" name="tab" value="urgent"/>');
    expect(page).toMatch(/<input[^>]*name="zip"[^>]*value="33301"/);
    expect(page).toMatch(/<input[^>]*name="q"[^>]*value="JF-18"/);
    expect(page).toContain('href="/admin/queue?tab=problems&zip=33301&q=JF-18"');
    expect(page).toContain(
      'href="/admin/queue?tab=urgent&zip=33301&q=JF-18&cursor=next%2Fcur%2Bsor"',
    );
    expect(page).toMatch(
      /href="\/admin\/queue\?tab=urgent&zip=33301&q=JF-18"[^>]*>Back to the start/,
    );
    expect(page).toMatch(/href="\/admin\/queue\?tab=urgent"[^>]*>Clear/);
    expect(page).toContain('<option value="' + CATEGORY_ID + '">Plumbing</option>');
  });

  it("hides the holder filter under Mine", async () => {
    api(() => pageOf([]));

    expect(await render({ tab: "mine" })).not.toContain('name="assigned"');
    expect(await render({ tab: "all" })).toContain('name="assigned"');
  });

  it.each([
    [{}, "No new requests."],
    [{ tab: "problems" }, "No open problems."],
    [{ tab: "mine" }, "You hold no requests."],
    [{ tab: "urgent", zip: "33301" }, "No request matches these filters."],
    [{ tab: "urgent", cursor: "abc-123" }, "No more requests."],
  ])("says why the list is empty (%j)", async (query, message) => {
    api(() => pageOf([]));

    const page = await render(query);

    expect(page).toContain(message);
    expect(page).not.toContain('role="alert"');
  });

  it("shows an error with a retry, and the tabs without counts, when the API fails", async () => {
    const refuse = () => Response.json({ error: { code: "x" } }, { status: 500 });
    api(refuse, { counts: refuse });

    const page = await render({ tab: "urgent", zip: "33301" });

    expect(page).toContain('role="alert"');
    expect(page).toContain("We couldn't load the queue. Try again in a moment.");
    expect(page).toMatch(/href="\/admin\/queue\?tab=urgent&zip=33301"[^>]*>Try again/);
    expect(page).not.toMatch(/Urgent\s*<span/);
  });

  it("still lists the requests when only the counts fail", async () => {
    api(() => pageOf([item()]), {
      counts: () => {
        throw new TypeError("fetch failed");
      },
    });

    const page = await render();

    expect(page).toContain("JF-000181");
    expect(page).not.toContain('role="alert"');
  });

  it("is in Spanish for a Spanish-speaking staff member", async () => {
    api(() => pageOf([item()]), { locale: "es" });

    const page = await render();

    for (const part of ["Cola de operaciones", "Nuevas", "Plomería", "Quedan 3:00", "Recibida"]) {
      expect(page).toContain(part);
    }
  });

  it("asks nothing of the staff routes without a staff session", async () => {
    api(() => pageOf([item()]), { role: "customer" });

    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);

    expect(requestsTo(fetchMock.mock.calls, LIST)).toEqual([]);
    expect(requestsTo(fetchMock.mock.calls, SUMMARY)).toEqual([]);
  });
});
