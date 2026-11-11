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

import {
  ACCESS_TOKEN,
  decoded,
  JOB_ID,
  me,
  requestsTo,
  signIn,
  ticket,
  TICKET_ID,
} from "../support-test-helpers";
import TicketPage from "./page";

const TICKET = `/v1/admin/support/tickets/${TICKET_ID}`;
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

function api(one: () => Response, locale = "en"): void {
  fetchMock.mockImplementation(
    routeFetch({ "/v1/auth/me": () => me("admin", locale), [TICKET]: one }),
  );
}

async function markup(ticketId = TICKET_ID): Promise<string> {
  return renderToStaticMarkup(await TicketPage({ params: Promise.resolve({ ticketId }) }));
}

async function render(ticketId = TICKET_ID): Promise<string> {
  return decoded(await markup(ticketId));
}

function pressed(page: string): Record<string, string | undefined> {
  const buttons = page.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g);
  return Object.fromEntries([...buttons].map(([, value, label]) => [label, value]));
}

describe("support ticket page", () => {
  it("shows the ticket with its message as typed and the status control", async () => {
    api(() =>
      Response.json(
        ticket({
          topic: "safety",
          role: "pro",
          job_id: JOB_ID,
          app_version: "9.8.7 (654)",
          platform: "ios",
          status: "in_progress",
        }),
      ),
    );

    const html = await markup();
    const page = decoded(html);

    const [request] = requestsTo(fetchMock.mock.calls, TICKET);
    expect(new Headers(request?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    for (const text of ["Safety", "Ana", "Pro", JOB_ID, "9.8.7 (654) · iOS", "All tickets"]) {
      expect(page).toContain(text);
    }
    // The text is shown as text, line breaks kept by the style: markup in it stays inert.
    expect(page).toContain(
      "The app froze on the payment step.\nCall me at 305-555-0142 <b>please</b>.",
    );
    expect(html).toContain("&lt;b&gt;please&lt;/b&gt;");
    expect(page).toContain("whitespace-pre-wrap");
    expect(pressed(page)).toEqual({ Open: "false", "In progress": "true", Closed: "false" });
    expect(page).toContain("Nov 7, 2026, 2:30 PM UTC");
    expect(page).not.toContain(ACCESS_TOKEN);
  });

  it("shows when a closed ticket was closed", async () => {
    api(() => Response.json(ticket({ status: "closed", closed_at: "2026-11-08T09:05:00Z" })));

    const page = await render();

    expect(page).toContain("Nov 8, 2026, 9:05 AM UTC");
    expect(pressed(page)).toEqual({ Open: "false", "In progress": "false", Closed: "true" });
  });

  it("says so when the ticket does not exist", async () => {
    api(() => Response.json({ error: { code: "ticket_not_found" } }, { status: 404 }));

    const page = await render();

    expect(page).toContain("This ticket doesn't exist.");
    expect(page).toContain('href="/admin/support"');
    expect(page).not.toContain("<button");
  });

  it.each(["not-a-uuid", "..", "%2e%2e", `${TICKET_ID}/../..`])(
    "never asks the API for an id that is not a UUID (%s)",
    async (ticketId) => {
      fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me("agent") }));

      const page = await render(ticketId);

      expect(page).toContain("This ticket doesn't exist.");
      expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        "/v1/auth/me",
      ]);
    },
  );

  it("shows the error state when the API fails", async () => {
    api(() => Response.json({ error: { code: "internal_error" } }, { status: 500 }));

    const page = await render();

    expect(page).toContain('role="alert"');
    expect(page).toContain("We couldn't load this ticket. Try again in a moment.");
    expect(page).not.toContain("<button");
  });

  it("speaks the staff member's language", async () => {
    api(() => Response.json(ticket({ user_first_name: null })), "es");

    const page = await render();

    for (const text of ["Pago", "Sin nombre registrado", "Mensaje", "Todos los tickets"]) {
      expect(page).toContain(text);
    }
    expect(pressed(page)).toEqual({ Abierto: "true", "En curso": "false", Cerrado: "false" });
  });

  it("asks nothing of the API without a staff session", async () => {
    fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me("customer") }));

    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);

    expect(requestsTo(fetchMock.mock.calls, TICKET)).toEqual([]);
  });
});
