import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REFRESH_COOKIE, SESSION_COOKIE } from "@/lib/session";
import {
  auth,
  bound,
  FakeCookieJar,
  MARKER,
  RedirectSignal,
  routeFetch,
  TOKENS,
} from "@/lib/test-helpers";

const { jar, revalidatePath } = vi.hoisted(() => ({
  jar: { current: null as unknown },
  revalidatePath: vi.fn<(path: string) => void>(),
}));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath }));

import { setTicketStatus } from "./actions";
import { ACCESS_TOKEN, me, requestsTo, signIn, ticket, TICKET_ID } from "./support-test-helpers";

const TICKET = `/v1/admin/support/tickets/${TICKET_ID}`;
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "2592000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  revalidatePath.mockReset();
});

function api(patch: () => Response, role: "agent" | "admin" | "customer" = "agent"): void {
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": () => me(role),
      "/v1/auth/logout": () => new Response(null, { status: 204 }),
      [TICKET]: patch,
    }),
  );
}

function form(status: string | null): FormData {
  const data = new FormData();
  if (status !== null) data.set("status", status);
  return data;
}

async function submit(status: string | null, ticketId = TICKET_ID) {
  return setTicketStatus(ticketId, { error: null, saved: false }, form(status));
}

function paths(): string[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

describe("setTicketStatus", () => {
  it.each(["open", "in_progress", "closed"])(
    "changes the status through the API with the staff token (%s)",
    async (status) => {
      api(() => Response.json(ticket()));

      const state = await submit(status);

      expect(state).toEqual({ error: null, saved: true });
      // The session is checked first, then the one PATCH.
      expect(paths()).toEqual(["/v1/auth/me", TICKET]);
      const [request] = requestsTo(fetchMock.mock.calls, TICKET);
      expect(request?.init?.method).toBe("PATCH");
      expect(JSON.parse(String(request?.init?.body))).toEqual({ status });
      expect(new Headers(request?.init?.headers).get("Authorization")).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      expect(revalidatePath.mock.calls.map(([path]) => path)).toEqual([
        `/admin/support/${TICKET_ID}`,
        "/admin/support",
      ]);
    },
  );

  it.each([
    ["an unknown status", "archived", TICKET_ID],
    ["no status", null, TICKET_ID],
    ["an id that is not a UUID", "closed", "not-a-uuid"],
    ["an id that walks the path", "closed", ".."],
    ["an id with a path in it", "closed", `${TICKET_ID}/../../auth/logout`],
  ])("refuses %s before anything is asked", async (_, status, ticketId) => {
    api(() => Response.json(ticket()));

    const state = await submit(status, ticketId);

    expect(state).toEqual({ error: "unavailable", saved: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [404, "not_found"],
    [403, "forbidden"],
    [401, "unavailable"],
    [422, "unavailable"],
    [500, "unavailable"],
  ] as const)("reports a refusal of the API (%i) and refreshes nothing", async (status, error) => {
    api(() => Response.json({ error: { code: "x", message: "x" } }, { status }));

    expect(await submit("closed")).toEqual({ error, saved: false });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a network failure", async () => {
    api(() => {
      throw new TypeError("fetch failed");
    });

    expect(await submit("closed")).toEqual({ error: "unavailable", saved: false });
  });

  it("renews an expired access token in place and still changes the status", async () => {
    // Fifteen minutes on a ticket: the access cookie is gone, the refresh cookie is not.
    cookies.reset({ [SESSION_COOKIE]: MARKER, [REFRESH_COOKIE]: bound("rt-old") });
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/refresh": () => Response.json(auth("agent")),
        "/v1/auth/me": () => me("agent"),
        [TICKET]: () => Response.json(ticket()),
      }),
    );

    const state = await submit("closed");

    // No redirect to a session route: the click is applied, with the renewed token.
    expect(state).toEqual({ error: null, saved: true });
    expect(paths()).toEqual(["/v1/auth/refresh", "/v1/auth/me", TICKET]);
    const [request] = requestsTo(fetchMock.mock.calls, TICKET);
    expect(new Headers(request?.init?.headers).get("Authorization")).toBe(
      `Bearer ${TOKENS.access_token}`,
    );
    expect(cookies.get(REFRESH_COOKIE)?.value).toBe(bound(TOKENS.refresh_token));
  });

  it.each(["customer", "none"] as const)(
    "changes nothing without a staff session (%s)",
    async (who) => {
      if (who === "none") cookies.reset({});
      api(() => Response.json(ticket()), "customer");

      // To the login, never to a session route (Next would follow that one on the server).
      await expect(submit("closed")).rejects.toMatchObject(new RedirectSignal("/admin/login"));

      expect(paths()).not.toContain(TICKET);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});
