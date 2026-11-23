import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, routeFetch, user } from "@/lib/test-helpers";

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
    // The action bar's forms read the router (to read the card again after a lost answer).
    useRouter: () => ({ refresh: () => {} }),
    // A missing record answers 404 (not-found.tsx, #494).
    notFound: () => {
      throw new Error("NEXT_NOT_FOUND");
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { AGENT_ID, card, MEDIA_URL, NOW, REQUEST_ID } from "../../queue/queue-test-helpers";
import { ACCESS_TOKEN, decoded, me, requestsTo, signIn } from "../../support/support-test-helpers";
import RequestPage from "./page";

const CARD = `/v1/admin/requests/${REQUEST_ID}`;
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

function api(one: () => Response, role: "agent" | "admin" = "agent", locale = "en"): void {
  fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me(role, locale), [CARD]: one }));
}

async function markup(requestId = REQUEST_ID): Promise<string> {
  return renderToStaticMarkup(await RequestPage({ params: Promise.resolve({ requestId }) }));
}

async function render(requestId = REQUEST_ID): Promise<string> {
  return decoded(await markup(requestId));
}

function text(page: string): string {
  return page.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");
}

/** The labels of the claim control's buttons, in order (the action bar's group left out). */
function buttons(page: string): string[] {
  const claim = page.replace(/<div role="group" aria-label="[^"]*"[\s\S]*?<\/div>/, "");
  return [...claim.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(([, label]) => label ?? "");
}

/** The href of every link that is not a page of the panel. */
function outsideLinks(page: string): string[] {
  return [...page.matchAll(/<a [^>]*href="([^"]+)"/g)]
    .map(([, href]) => href ?? "")
    .filter((href) => !href.startsWith("/"));
}

describe("request card page", () => {
  it("shows who to call, the request as typed, the media, the quotes and the claim button", async () => {
    api(() => Response.json(card()));

    const html = await markup();
    const page = decoded(html);
    const words = text(page);

    const [request] = requestsTo(fetchMock.mock.calls, CARD);
    expect(new Headers(request?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request?.init?.cache).toBe("no-store");
    for (const part of [
      "JF-000181",
      "Ana Probelast",
      "+13055550181",
      "ana.probe+81@example.com",
      "ES",
      "742 Evergreen Terrace, Apt 81",
      "Fort Lauderdale, FL 33301",
      "Plumbing",
      "From the app",
      "3:00 left",
      "Request received",
      "Nov 9, 2026 · Morning",
      "leak_location Under the sink",
      "urgent true",
      "María P.",
      "$185.50",
      "Pending",
      "Still being prepared: 1",
      "No job yet",
      "Nobody holds this request.",
    ]) {
      expect(words).toContain(part);
    }
    // The contact links are built here, from the phone and the email alone.
    expect(outsideLinks(page)).toEqual([
      "tel:+13055550181",
      "sms:+13055550181",
      "mailto:ana.probe%2B81@example.com",
    ]);
    // The customer's own text is shown as text, line breaks kept by the style: markup stays inert.
    expect(page).toContain("The kitchen faucet drips.\nCall me at 305-555-0181 <b>today</b>.");
    expect(html).toContain("&lt;b&gt;today&lt;/b&gt;");
    // The media opens in a new tab through the panel's own route: the signed storage address
    // is in no link and nowhere else in the page (Vault round 1 on #418).
    const [media] = page.match(/<a [^>]*href="\/admin\/requests\/[^"]+\/media\/0"[^>]*>/g) ?? [];
    expect(media).toContain(`href="/admin/requests/${REQUEST_ID}/media/0"`);
    expect(media).toContain('target="_blank"');
    expect(media).toContain('rel="noopener noreferrer"');
    expect(page).not.toContain(MEDIA_URL);
    expect(page).not.toContain("sig=probe");
    expect(page).not.toContain("storage.test.invalid");
    expect(buttons(page)).toEqual(["Take this request"]);
    expect(page).not.toContain('disabled=""');
    expect(page).not.toContain(ACCESS_TOKEN);
  });

  it("offers a release to the holder, shows the job and no timer once contacted", async () => {
    api(() =>
      Response.json(
        card({
          status: "accepted",
          bucket: "scheduled_today",
          customer_status: "customerStatus.professionalOnTheWay",
          first_contact_at: "2026-11-07T14:29:00Z",
          last_contact_at: "2026-11-07T14:29:30Z",
          next_action: "Call back <i>at noon</i>",
          urgency: "high",
          assigned_agent: { id: user("agent").id, name: "Eva" },
          customer: {
            id: "c057f3a5-1111-4222-8333-944455556681",
            first_name: null,
            last_name: null,
            phone: "305-555-0181",
            email: "not-an-email",
            language: "en",
            has_account: true,
          },
          media: [],
          media_pending: 0,
          quotes: [],
          intake_answers: {},
          preferred_date: null,
          preferred_period: null,
          job: {
            id: "10b0f3a5-1111-4222-8333-944455556681",
            status: "on_the_way",
            scheduled_start_at: "2026-11-07T15:00:00Z",
            started_at: null,
            completed_at: null,
            confirmed_at: null,
            events: [
              {
                type: "created",
                from_status: null,
                to_status: "scheduled",
                by_system: true,
                created_at: "2026-11-06T10:00:00Z",
              },
              {
                type: "status_changed",
                from_status: "scheduled",
                to_status: "on_the_way",
                by_system: false,
                created_at: "2026-11-07T14:20:00Z",
              },
            ],
          },
        }),
      ),
    );

    const html = await markup();
    const page = decoded(html);
    const words = text(page);

    for (const part of [
      "Urgent",
      "Scheduled today",
      "Accepted",
      "No name on file",
      "Professional on the way",
      "You hold this request.",
      "None attached.",
      "No quotes yet.",
      "On the way",
      "Nov 7, 2026, 3:00 PM UTC",
      "Scheduled (automatic)",
    ]) {
      expect(words).toContain(part);
    }
    // The next action is staff's own note, shown as text too.
    expect(page).toContain("Call back <i>at noon</i>");
    expect(html).toContain("&lt;i&gt;at noon&lt;/i&gt;");
    expect(page).not.toContain("data-tone=");
    // A phone that is not E.164 and an email that is not one give no link at all.
    expect(outsideLinks(page)).toEqual([]);
    expect(buttons(page)).toEqual(["Release"]);
  });

  it.each([
    ["agent", "Sam holds this request.", []],
    ["admin", "Sam holds this request.", ["Release"]],
  ] as const)(
    "lets only an admin release a request someone else holds (%s)",
    async (role, sentence, offered) => {
      api(() => Response.json(card({ assigned_agent: { id: AGENT_ID, name: "Sam" } })), role);

      const page = await render();

      expect(text(page)).toContain(sentence);
      expect(buttons(page)).toEqual(offered);
      // The claim control stays on the card even without a button, so a take that lost the
      // race keeps its announcement after the refresh (Gatekeeper round 1 on #418).
      expect(page).toContain('role="status"');
    },
  );

  it.each(["not-a-uuid", "..", `${REQUEST_ID}x`, "JF-000181"])(
    "never asks the API for an id that is not a UUID (%s)",
    async (requestId) => {
      api(() => Response.json(card()));

      await expect(render(requestId)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(requestsTo(fetchMock.mock.calls, CARD)).toEqual([]);
    },
  );

  it("says Deleted user for a deleted customer and a deleted pro's quote (#97)", async () => {
    const base = card();
    api(() =>
      Response.json(
        card({
          customer_name: null,
          customer_deleted: true,
          customer: { ...base.customer, first_name: null, last_name: null },
          quotes: base.quotes.map((quote) => ({ ...quote, pro_name: null, pro_deleted: true })),
        }),
      ),
    );

    const words = text(await render());

    // Once in the customer's details, once on the quote.
    expect(words.split("Deleted user")).toHaveLength(3);
    expect(words).not.toContain("No name on file");
  });

  it("answers 404 when the request does not exist (#494)", async () => {
    api(() => Response.json({ error: { code: "request_not_found" } }, { status: 404 }));

    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([
    ["the API refuses", () => Response.json({ error: { code: "x" } }, { status: 500 })],
    [
      "the API cannot be reached",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("shows an error when %s", async (_, answer) => {
    api(answer);

    const page = await render();

    expect(page).toContain('role="alert"');
    expect(page).toContain("We couldn't load this request. Try again in a moment.");
    expect(outsideLinks(page)).toEqual([]);
  });

  it("is in Spanish for a Spanish-speaking staff member", async () => {
    api(() => Response.json(card()), "agent", "es");

    const words = text(await render());

    for (const part of [
      "Cola de operaciones",
      "Cliente",
      "Llamar",
      "Enviar SMS",
      "Quedan 3:00",
      "Plomería",
      "Presupuestos",
      "Tomar esta solicitud",
      "Solicitud recibida",
    ]) {
      expect(words).toContain(part);
    }
  });
});
