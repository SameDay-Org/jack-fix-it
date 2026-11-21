import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch, user } from "@/lib/test-helpers";

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
    useRouter: () => ({ refresh: () => {} }),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { AGENT_ID, NOW, REQUEST_ID } from "../queue/queue-test-helpers";
import type { FollowupItem } from "../requests/ops";
import { decoded, me, requestsTo, signIn } from "../support/support-test-helpers";
import FollowupsLoading from "./loading";
import FollowupsPage from "./page";

const LIST = "/v1/admin/followups";
const SELF = user("agent").id;
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW)); // 2026-11-07 at 09:30 in New York
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("BUSINESS_TIME_ZONE", "America/New_York");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function item(extra: Partial<FollowupItem> = {}): FollowupItem {
  return {
    id: "3c3c3c3c-1111-4222-8333-944455556666",
    request_id: REQUEST_ID,
    assigned_to: { id: SELF, name: "Probe" },
    due_at: "2026-11-07T20:00:00Z",
    note: "Call back after lunch.",
    done_at: null,
    public_code: "JF-000081",
    request_status: "reviewing",
    ...extra,
  };
}

function api(list: () => Response, role: "agent" | "admin" = "agent", locale = "en"): void {
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": () => me(role, locale),
      [LIST]: list,
      "/v1/admin/staff": () =>
        Response.json({
          staff: [
            { id: SELF, first_name: "Probe", role: "admin" },
            { id: AGENT_ID, first_name: "Sam", role: "agent" },
          ],
        }),
    }),
  );
}

async function render(query: Record<string, string> = {}): Promise<string> {
  return decoded(
    renderToStaticMarkup(await FollowupsPage({ searchParams: Promise.resolve(query) })),
  );
}

function listCalls(): URLSearchParams[] {
  return requestsTo(fetchMock.mock.calls, LIST).map(({ url }) => url.searchParams);
}

describe("the follow-ups page", () => {
  it("asks for mine due today by default, then all open ones when chosen", async () => {
    api(() => Response.json({ items: [], next_cursor: null }));
    await render();
    await render({ due: "all" });
    await render({ due: "someday" });
    expect(listCalls().map((params) => params.get("due"))).toEqual(["today", "all", "today"]);
    expect(listCalls().every((params) => !params.has("assignee"))).toBe(true);
  });

  it("lets an admin read another staff member's, never an agent", async () => {
    api(() => Response.json({ items: [], next_cursor: null }), "admin");
    const admin = await render({ assignee: AGENT_ID });
    expect(listCalls().at(-1)?.get("assignee")).toBe(AGENT_ID);
    expect(admin).toMatch(/<select id="followups-assignee" name="assignee"/);
    expect(admin).toContain(">Sam</option>");

    api(() => Response.json({ items: [], next_cursor: null }), "agent");
    const agent = await render({ assignee: AGENT_ID });
    expect(listCalls().at(-1)?.has("assignee")).toBe(false);
    expect(agent).not.toContain("followups-assignee");
    expect(requestsTo(fetchMock.mock.calls, "/v1/admin/staff")).toHaveLength(1); // the admin's
  });

  it("never sends an agent's own id as the assignee: the parameter is an admin's (#499 round 1)", async () => {
    api(() => Response.json({ items: [], next_cursor: null }), "agent");
    await render({ assignee: SELF });
    expect(listCalls().at(-1)?.has("assignee")).toBe(false);
  });

  it("says calmly when the account may not read the list now, with a way to its own", async () => {
    // An admin demoted since the page was opened asks for another's list: 403.
    api(
      () => Response.json({ error: { code: "forbidden", message: "raw" } }, { status: 403 }),
      "admin",
    );
    const html = await render({ due: "all", assignee: AGENT_ID });
    expect(html).toMatch(/<div [^>]*role="alert"/);
    expect(html).toContain("Your account can't read this list now.");
    expect(html).toContain('href="/admin/followups?due=all"');
    expect(html).not.toContain("We couldn't load the follow-ups.");
    expect(html).not.toContain("raw");
  });

  it("lists each follow-up with its request's code and status, what to do, when and for whom", async () => {
    api(() =>
      Response.json({
        items: [
          item({ due_at: "2026-11-07T13:00:00Z", note: "Overdue: call.\n<b>now</b>" }),
          item({
            id: "3d3d3d3d-1111-4222-8333-944455556666",
            assigned_to: { id: AGENT_ID, name: "Sam" },
          }),
          item({ id: "3e3e3e3e-1111-4222-8333-944455556666", due_at: "2026-11-09T15:00:00Z" }),
        ],
        next_cursor: null,
      }),
    );
    const html = await render({ due: "all" });
    const rows = [...html.matchAll(/<li data-followup="(\w+)">([\s\S]*?)<\/li>/g)];
    expect(rows.map(([, tone]) => tone)).toEqual(["overdue", "today", "later"]);
    expect(rows[0]![2]).toContain(`href="/admin/requests/${REQUEST_ID}"`);
    expect(rows[0]![2]).toContain(">JF-000081<");
    expect(rows[0]![2]).toContain(">Reviewing<");
    expect(rows[0]![2]).toContain(">Overdue<");
    expect(rows[0]![2]).toContain("Overdue: call.\n<b>now</b>"); // as text (decoded here)
    expect(rows[1]![2]).toContain(">Due today<");
    expect(rows[1]![2]).toContain(">Sam<");
    // Mark done for the reader's own, not for Sam's (an agent's page).
    expect(rows.map(([, , body]) => body!.includes(">Mark done<"))).toEqual([true, false, true]);
    expect(html).not.toMatch(/tel:|mailto:|sms:/);
  });

  it("writes a follow-up's note as text", async () => {
    api(() =>
      Response.json({ items: [item({ note: "<script>alert(1)</script>" })], next_cursor: null }),
    );
    const raw = renderToStaticMarkup(await FollowupsPage({ searchParams: Promise.resolve({}) }));
    expect(raw).not.toContain("<script>alert");
    expect(raw).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("pages with the cursor, keeping the view, and offers the first page back", async () => {
    api(() => Response.json({ items: [item()], next_cursor: "abc" }));
    const first = await render({ due: "all" });
    expect(first).toContain('href="/admin/followups?due=all&cursor=abc"');
    const second = await render({ due: "all", cursor: "abc" });
    expect(listCalls().at(-1)?.get("cursor")).toBe("abc");
    expect(second).toContain('href="/admin/followups?due=all"');
  });

  it("goes back to the first page calmly when the API refuses a stale cursor", async () => {
    api(() => Response.json({ error: { code: "validation_error" } }, { status: 422 }));
    const html = await render({ cursor: "stale" });
    expect(html).toContain("The list changed since this page: back to the first page.");
    expect(html).toContain('href="/admin/followups"');
  });

  it.each([
    [{}, "Nothing due today."],
    [{ due: "all" }, "No open follow-ups."],
  ])("says when there is nothing in %o", async (query, text) => {
    api(() => Response.json({ items: [], next_cursor: null }));
    expect(await render(query)).toContain(text);
  });

  it("shows an error with a retry when the API fails", async () => {
    api(() => Response.json({ error: { code: "x", message: "raw" } }, { status: 500 }));
    const html = await render();
    expect(html).toMatch(/<div [^>]*role="alert"/);
    expect(html).toContain("We couldn't load the follow-ups.");
    expect(html).not.toContain("raw");
  });

  it("speaks Spanish", async () => {
    api(() => Response.json({ items: [item()], next_cursor: null }), "agent", "es");
    const html = await render();
    expect(html).toContain("Seguimientos");
    expect(html).toContain(">Para hoy<");
  });

  it("asks nothing without a staff session", async () => {
    cookies.reset({});
    api(() => Response.json({ items: [], next_cursor: null }));
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(listCalls()).toHaveLength(0);
  });

  it("has a loading frame", async () => {
    api(() => Response.json({ items: [], next_cursor: null }));
    const html = decoded(renderToStaticMarkup(await FollowupsLoading()));
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<p role="status"[^>]*>Loading follow-ups…<\/p>/);
  });
});
