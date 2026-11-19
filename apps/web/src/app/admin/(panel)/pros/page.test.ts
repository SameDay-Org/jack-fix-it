import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({
  cookies: async () => jar.current,
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});

import { ACCESS_TOKEN, decoded, me, requestsTo, signIn } from "../support/support-test-helpers";
import ProsPage from "./page";
import { item, OTHER_PRO_ID, page as pageOf, PRO_ID } from "./pros-test-helpers";

const PROS = "/v1/admin/pros";
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function api(pros: () => Response, locale = "en", role: "agent" | "customer" = "agent"): void {
  fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me(role, locale), [PROS]: pros }));
}

async function render(query: Record<string, string | string[]> = {}): Promise<string> {
  return decoded(renderToStaticMarkup(await ProsPage({ searchParams: Promise.resolve(query) })));
}

function listRequest(): { url: URL; init: RequestInit | undefined } {
  const [request] = requestsTo(fetchMock.mock.calls, PROS);
  if (!request) throw new Error("the list was not requested");
  return request;
}

describe("pros list page", () => {
  it("lists the pending pros with the staff session's token and each tab's count", async () => {
    api(() =>
      Response.json(
        pageOf([
          item(),
          item({
            id: OTHER_PRO_ID,
            name: null,
            payouts_enabled: true,
            categories: [],
            zip_count: 0,
            documents: { pending: 0, approved: 0, rejected: 0 },
            submitted_at: null,
          }),
        ]),
      ),
    );

    const page = await render();

    const { url, init } = listRequest();
    expect(url.search).toBe("?status=pending");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init?.cache).toBe("no-store");
    for (const text of [
      "Lucía R.",
      "Plumbing",
      "Pending: 2",
      "Approved: 1",
      "Payouts not set up",
    ]) {
      expect(page).toContain(text);
    }
    expect(page).not.toContain("Rejected: 0");
    for (const text of ["No name on file", "No categories yet", "No documents yet"]) {
      expect(page).toContain(text);
    }
    expect(page).toContain("Nothing to review");
    expect(page).toContain("Nov 7, 2026, 2:30 PM UTC");
    expect(page).toContain(`href="/admin/pros/${PRO_ID}"`);
    expect(page).toContain(`href="/admin/pros/${OTHER_PRO_ID}"`);
    // Pending is the first tab and the one in use; every tab shows how many pros it holds.
    const tabs = [...page.matchAll(/<a [^>]*href="(\/admin\/pros[^"/]*)"[^>]*>(.*?)<\/a>/g)].map(
      ([tag, href, label]) => ({
        href,
        text: label
          ?.replaceAll(/<[^>]+>/g, " ")
          .replaceAll(/\s+/g, " ")
          .trim(),
        current: tag.includes('aria-current="true"'),
      }),
    );
    expect(tabs).toEqual([
      { href: "/admin/pros", text: "Pending 7", current: true },
      { href: "/admin/pros?status=approved", text: "Approved 12", current: false },
      { href: "/admin/pros?status=rejected", text: "Rejected 1", current: false },
    ]);
    expect(page).not.toContain("Older pros");
    expect(page).not.toContain(ACCESS_TOKEN);
  });

  it.each([
    [{ status: "approved" }, "?status=approved"],
    [{ status: "rejected" }, "?status=rejected"],
    [{ status: "superseded" }, "?status=pending"],
    [{ status: ["approved", "rejected"] }, "?status=pending"],
    [{ status: "approved", cursor: "abc-123" }, "?status=approved&cursor=abc-123"],
  ])("asks the API for the tab in the URL (%j)", async (query, search) => {
    api(() => Response.json(pageOf([])));

    await render(query);

    expect(listRequest().url.search).toBe(search);
  });

  it("links to the older pros and back to the newest", async () => {
    api(() =>
      Response.json(
        pageOf([item({ verification_status: "approved" })], { next_cursor: "next/cur+sor" }),
      ),
    );

    const page = await render({ status: "approved", cursor: "abc-123" });

    expect(page).toContain('href="/admin/pros?status=approved&cursor=next%2Fcur%2Bsor"');
    expect(page).toContain("Older pros");
    expect(page).toMatch(/<a[^>]*href="\/admin\/pros\?status=approved"[^>]*>Back to the newest/);
  });

  it.each([
    ["pending", "No pros are waiting for a decision."],
    ["approved", "No approved pros yet."],
    ["rejected", "No rejected pros."],
  ])("says when a tab is empty (%s)", async (status, text) => {
    api(() => Response.json(pageOf([])));

    const page = await render({ status });

    expect(page).toContain(text);
    expect(page).not.toContain('role="alert"');
  });

  it("says when a cursor is past the last page", async () => {
    api(() => Response.json(pageOf([])));

    const page = await render({ cursor: "abc-123" });

    expect(page).toContain("No older pros.");
    expect(page).not.toContain("No pros are waiting for a decision.");
    expect(page).toContain("Back to the newest");
  });

  it.each([
    ["the API refuses", () => Response.json({ error: { code: "x" } }, { status: 500 })],
    [
      "the API cannot be reached",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("shows an error with a retry when %s", async (_, answer) => {
    api(answer);

    const page = await render({ status: "rejected" });

    expect(page).toContain('role="alert"');
    expect(page).toContain("We couldn't load the pros. Try again in a moment.");
    expect(page).toMatch(/<a[^>]*href="\/admin\/pros\?status=rejected"[^>]*>Try again/);
    // No count without an answer.
    expect(page).not.toMatch(/Pending\s*<span/);
  });

  it("is in Spanish for a Spanish-speaking staff member", async () => {
    api(() => Response.json(pageOf([item()])), "es");

    const page = await render();

    for (const text of ["Profesionales", "Pendientes", "Plomería", "Pagos sin configurar"]) {
      expect(page).toContain(text);
    }
  });

  it("asks nothing of the staff routes without a staff session", async () => {
    api(() => Response.json(pageOf([item()])), "en", "customer");

    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);

    expect(requestsTo(fetchMock.mock.calls, PROS)).toEqual([]);
  });
});
