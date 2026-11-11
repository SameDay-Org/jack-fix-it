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

import SupportPage from "./page";
import {
  ACCESS_TOKEN,
  decoded,
  item,
  JOB_ID,
  me,
  MESSAGE,
  requestsTo,
  signIn,
  TICKET_ID,
} from "./support-test-helpers";

const TICKETS = "/v1/admin/support/tickets";
const OTHER_ID = "9d8c7b6a-1111-4222-8333-044455556666";
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

function api(tickets: () => Response, locale = "en"): void {
  fetchMock.mockImplementation(
    routeFetch({ "/v1/auth/me": () => me("agent", locale), [TICKETS]: tickets }),
  );
}

async function render(query: Record<string, string | string[]> = {}): Promise<string> {
  return decoded(renderToStaticMarkup(await SupportPage({ searchParams: Promise.resolve(query) })));
}

function listRequest(): { url: URL; init: RequestInit | undefined } {
  const [request] = requestsTo(fetchMock.mock.calls, TICKETS);
  if (!request) throw new Error("the list was not requested");
  return request;
}

describe("support list page", () => {
  it("lists the open tickets with the staff session's token", async () => {
    api(() =>
      Response.json({
        items: [
          item({ job_id: JOB_ID }),
          item({ id: OTHER_ID, user_first_name: null, role: "pro", topic: "app_problem" }),
        ],
        next_cursor: null,
      }),
    );

    const page = await render();

    const { url, init } = listRequest();
    expect(url.search).toBe("?status=open");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init?.cache).toBe("no-store");
    for (const text of ["Support", "Ana", "Customer", "Payment", "About a job", "Open"]) {
      expect(page).toContain(text);
    }
    for (const text of ["No name on file", "Pro", "App problem"]) expect(page).toContain(text);
    expect(page).toContain(`href="/admin/support/${TICKET_ID}"`);
    expect(page).toContain(`href="/admin/support/${OTHER_ID}"`);
    // The filter in use is marked, and the time carries its zone.
    const current = (page.match(/<a [^>]*>/g) ?? []).filter((a) =>
      a.includes('aria-current="true"'),
    );
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/admin/support"');
    expect(page).toContain("Nov 7, 2026, 2:30 PM UTC");
    expect(page).not.toContain("Older tickets");
    // Neither the token nor a message is ever in the page.
    expect(page).not.toContain(ACCESS_TOKEN);
    expect(page).not.toContain(MESSAGE);
  });

  it.each([
    [{ status: "closed" }, "?status=closed"],
    [{ status: "in_progress" }, "?status=in_progress"],
    [{ status: "all" }, ""],
    [{ status: "archived" }, "?status=open"],
    [{ status: ["closed", "all"] }, "?status=open"],
    [{ status: "closed", cursor: "abc-123" }, "?status=closed&cursor=abc-123"],
  ])("asks the API for the filter in the URL (%j)", async (query, search) => {
    api(() => Response.json({ items: [], next_cursor: null }));

    await render(query);

    expect(listRequest().url.search).toBe(search);
  });

  it("links to the older tickets and back to the newest", async () => {
    api(() => Response.json({ items: [item({ status: "closed" })], next_cursor: "next/cur+sor" }));

    const page = await render({ status: "closed", cursor: "abc-123" });

    expect(page).toContain('href="/admin/support?status=closed&cursor=next%2Fcur%2Bsor"');
    expect(page).toContain("Older tickets");
    expect(page).toMatch(/<a[^>]*href="\/admin\/support\?status=closed"[^>]*>Back to the newest/);
  });

  it.each([
    [{}, "No open tickets."],
    [{ status: "in_progress" }, "No tickets in progress."],
    [{ status: "closed" }, "No closed tickets."],
    [{ status: "all" }, "No tickets yet."],
  ])("shows the empty state of the filter (%j)", async (query, text) => {
    api(() => Response.json({ items: [], next_cursor: null }));

    expect(await render(query)).toContain(text);
  });

  it("offers the way back from a page past the last one", async () => {
    // The older tickets changed status since the cursor was issued: not "no tickets".
    api(() => Response.json({ items: [], next_cursor: null }));

    const page = await render({ status: "closed", cursor: "abc-123" });

    expect(page).toContain("No older tickets.");
    expect(page).not.toContain("No closed tickets.");
    expect(page).toMatch(/<a[^>]*href="\/admin\/support\?status=closed"[^>]*>Back to the newest/);
  });

  it.each([
    ["the API fails", () => Response.json({ error: { code: "internal_error" } }, { status: 500 })],
    ["the cursor is refused", () => Response.json({ error: { code: "x" } }, { status: 422 })],
    [
      "the network fails",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("shows the error state with a way to retry when %s", async (_, tickets) => {
    api(tickets);

    const page = await render({ status: "closed", cursor: "abc-123" });

    expect(page).toContain('role="alert"');
    expect(page).toContain("We couldn't load the tickets. Try again in a moment.");
    expect(page).toMatch(/<a[^>]*href="\/admin\/support\?status=closed"[^>]*>Try again/);
  });

  it("speaks the staff member's language", async () => {
    api(() => Response.json({ items: [item({ topic: "safety" })], next_cursor: null }), "es");

    const page = await render();

    for (const text of ["Soporte", "Abiertos", "Cliente", "Seguridad", "Abierto"]) {
      expect(page).toContain(text);
    }
    expect(page).not.toContain("Open");
  });

  it("asks nothing of the API without a staff session", async () => {
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me("customer") }));

    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);

    expect(requestsTo(fetchMock.mock.calls, TICKETS)).toEqual([]);
  });
});
