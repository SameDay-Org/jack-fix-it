import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, routeFetch, user } from "@/lib/test-helpers";

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { AGENT_ID, card, CATEGORY_ID, NOW, REQUEST_ID } from "../../queue/queue-test-helpers";
import { decoded, me, requestsTo, signIn } from "../../support/support-test-helpers";
import type { Followup, Note } from "../ops";
import RequestPage from "./page";

const CARD = `/v1/admin/requests/${REQUEST_ID}`;
const SELF = user("agent").id;
const OTHER = { id: AGENT_ID, name: "Sam" };
const CATEGORIES = [
  { id: CATEGORY_ID, slug: "handyman", names: { en: "Handyman", es: "Manitas" } },
];
const STAFF = {
  staff: [
    { id: SELF, first_name: "Probe", role: "admin" },
    { id: AGENT_ID, first_name: "Sam", role: "agent" },
  ],
};
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW)); // 2026-11-07 at 09:30 in New York
  const cookies = new FakeCookieJar();
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

function api(
  body: ReturnType<typeof card>,
  role: "agent" | "admin" = "agent",
  locale = "en",
  categories: unknown = CATEGORIES,
): void {
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": () => me(role, locale),
      [CARD]: () => Response.json(body),
      "/v1/categories": () => Response.json(categories),
      "/v1/admin/staff": () => Response.json(STAFF),
    }),
  );
}

async function markup(): Promise<string> {
  return renderToStaticMarkup(
    await RequestPage({ params: Promise.resolve({ requestId: REQUEST_ID }) }),
  );
}

/** The action bar's buttons, in order (none when there is no bar). */
function bar(html: string): string[] {
  const group = /<div role="group" aria-label="[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  return [...(group?.[1] ?? "").matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(
    ([, label]) => label!,
  );
}

function asked(path: string): number {
  return requestsTo(fetchMock.mock.calls, path).length;
}

function note(extra: Partial<Note>): Note {
  return {
    id: "1a1a1a1a-1111-4222-8333-944455556666",
    author: OTHER,
    body: "First call: no answer.",
    created_at: "2026-11-07T13:00:00Z",
    ...extra,
  };
}

function followup(extra: Partial<Followup>): Followup {
  return {
    id: "2b2b2b2b-1111-4222-8333-944455556666",
    request_id: REQUEST_ID,
    assigned_to: { id: SELF, name: "Probe" },
    due_at: "2026-11-07T20:00:00Z",
    note: "Call back after lunch.",
    done_at: null,
    ...extra,
  };
}

describe("the request card's actions", () => {
  it("gives an agent who may act every action of a new request", async () => {
    api(card({ status: "received", actions_allowed: true }));
    expect(bar(await markup())).toEqual([
      "Add note",
      "Mark contacted",
      "Classify",
      "Schedule follow-up",
    ]);
    expect(asked("/v1/categories")).toBe(1);
    // Public and the same for everyone: read from the hourly cache, never once per card view
    // (the endpoint is rate-limited per address, and the panel's server is one address).
    const [categories] = requestsTo(fetchMock.mock.calls, "/v1/categories");
    expect(categories?.init?.cache).toBeUndefined();
    expect((categories?.init as { next?: { revalidate?: number } })?.next?.revalidate).toBe(3600);
    // The assignee picker is an admin's: an agent's page never asks for the staff.
    expect(asked("/v1/admin/staff")).toBe(0);
  });

  it("names who holds the request instead of the bar when the API says the reader may not act", async () => {
    // No answers to name either (#546): nothing needs the categories.
    api(
      card({
        status: "received",
        actions_allowed: false,
        assigned_agent: OTHER,
        intake_answers: {},
      }),
    );
    const html = decoded(await markup());
    expect(bar(html)).toEqual([]);
    expect(html).toContain("Sam holds this request: take it to act on it.");
    expect(asked("/v1/categories")).toBe(0);
  });

  it.each(["finding_pro", "quote_ready", "accepted", "expired", "cancelled"] as const)(
    "offers no Classify once the request is %s (the API would refuse it)",
    async (status) => {
      api(card({ status, actions_allowed: true, intake_answers: {} }));
      expect(bar(await markup())).not.toContain("Classify");
      expect(asked("/v1/categories")).toBe(0);
    },
  );

  it("offers no Mark contacted once the first contact is recorded", async () => {
    api(card({ status: "reviewing", first_contact_at: "2026-11-07T14:00:00Z" }));
    expect(bar(await markup())).toEqual(["Add note", "Classify", "Schedule follow-up"]);
  });

  it("reads the staff for an admin, who may give a follow-up to someone else", async () => {
    api(card({ status: "received" }), "admin");
    await markup();
    expect(asked("/v1/admin/staff")).toBe(1);
  });

  it("speaks Spanish", async () => {
    api(card({ status: "received" }), "agent", "es");
    expect(bar(decoded(await markup()))).toEqual([
      "Agregar nota",
      "Marcar como contactado",
      "Clasificar",
      "Programar seguimiento",
    ]);
  });
});

describe("the request card's notes", () => {
  it("shows them newest first, as text, with who wrote each", async () => {
    const hostile = 'Called.\n<script>alert("x")</script><img src=x onerror=alert(1)>';
    api(
      card({
        notes: [
          note({ body: "First call: no answer." }),
          note({
            id: "1b1b1b1b-1111-4222-8333-944455556666",
            author: { id: SELF, name: "Probe" },
            body: hostile,
            created_at: "2026-11-07T14:00:00Z",
          }),
        ],
      }),
    );
    const raw = await markup();
    // React wrote the text: no element came out of it.
    expect(raw).not.toContain("<script>alert");
    expect(raw).not.toContain("<img src=x");
    expect(raw).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    const html = decoded(raw);
    const bodies = [...html.matchAll(/<p data-note="true"[^>]*>([\s\S]*?)<\/p>/g)].map(
      ([, text]) => text,
    );
    expect(bodies).toEqual([hostile, "First call: no answer."]);
    expect(html).toMatch(/<span class="font-semibold text-navy-900">You<\/span>/);
    expect(html).toMatch(/<span class="font-semibold text-navy-900">Sam<\/span>/);
    expect(html).toContain("Staff only: the customer and the pro never see these.");
  });

  it("says when there are none", async () => {
    api(card({ notes: [] }));
    expect(decoded(await markup())).toContain("No notes yet.");
  });
});

describe("the request card's follow-ups", () => {
  const set = [
    followup({ due_at: "2026-11-07T13:00:00Z", note: "Overdue one." }),
    followup({
      id: "2c2c2c2c-1111-4222-8333-944455556666",
      due_at: "2026-11-07T20:00:00Z",
      note: "Today's, Sam's.",
      assigned_to: OTHER,
    }),
    followup({
      id: "2d2d2d2d-1111-4222-8333-944455556666",
      due_at: "2026-11-09T15:00:00Z",
      note: "Later one.",
    }),
    followup({
      id: "2e2e2e2e-1111-4222-8333-944455556666",
      due_at: "2026-11-06T15:00:00Z",
      note: "Done one.",
      done_at: "2026-11-06T16:00:00Z",
    }),
  ];

  function items(html: string) {
    return [...html.matchAll(/<li data-followup="(\w+)"[^>]*>([\s\S]*?)<\/li>/g)].map(
      ([, tone, body]) => ({
        tone,
        note: /<p class="break-words whitespace-pre-wrap">([^<]*)<\/p>/.exec(body!)?.[1],
        done: body!.includes(">Mark done<"),
      }),
    );
  }

  it("marks overdue and due today, and offers Mark done to its assignee only", async () => {
    api(card({ followups: set }));
    const html = decoded(await markup());
    expect(items(html)).toEqual([
      { tone: "overdue", note: "Overdue one.", done: true },
      { tone: "today", note: "Today's, Sam's.", done: false },
      { tone: "later", note: "Later one.", done: true },
      { tone: "done", note: "Done one.", done: false },
    ]);
    expect(html).toContain(">Overdue<");
    expect(html).toContain(">Due today<");
  });

  it("offers an admin Mark done on another's follow-up too", async () => {
    api(card({ followups: set }), "admin");
    const done = items(decoded(await markup())).map((item) => item.done);
    expect(done).toEqual([true, true, true, false]);
  });

  it("tells an agent the list is only theirs, and says so when there are none (#499 round 1)", async () => {
    // The API shows an agent only the follow-ups assigned to them: the copy never reads the
    // list as everyone's. The role is the one /me answers now, not the token's.
    api(card({ followups: [] }));
    const html = decoded(await markup());
    expect(html).toContain("Only the follow-ups assigned to you show here.");
    expect(html).toContain("None assigned to you on this request.");
    expect(html).not.toContain("Every follow-up on this request");
  });

  it("tells an admin the list is every one", async () => {
    api(card({ followups: [] }), "admin");
    const html = decoded(await markup());
    expect(html).toContain("Every follow-up on this request, whoever it is assigned to.");
    expect(html).toContain("No follow-ups on this request.");
    expect(html).not.toContain("assigned to you");
  });
});

describe("the request's answers (#546)", () => {
  const QUESTIONS = [
    {
      key: "leak_location",
      type: "text",
      required: true,
      labels: { en: "Where is the leak?", es: "¿Dónde está la fuga?" },
      max_length: 200,
    },
    {
      key: "urgent",
      type: "boolean",
      required: false,
      labels: { en: "Is it urgent?", es: "¿Es urgente?" },
    },
    {
      key: "rooms",
      type: "multi_choice",
      required: false,
      labels: { en: "Which rooms?", es: "¿Qué cuartos?" },
      min_selected: 0,
      options: [
        { value: "kitchen", labels: { en: "Kitchen", es: "Cocina" } },
        { value: "bathroom", labels: { en: "Bathroom", es: "Baño" } },
      ],
    },
  ];
  const ANSWERS = {
    leak_location: "Under the sink",
    urgent: true,
    rooms: ["kitchen", "attic"],
    retired_key: "Kept as typed",
  };

  /** The card's facts as (term, value) pairs. */
  function facts(html: string): [string, string][] {
    return [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map(
      ([, term, value]) => [term!, value!],
    );
  }

  it.each([
    [
      "en",
      [
        ["Where is the leak?", "Under the sink"],
        ["Is it urgent?", "Yes"],
        ["Which rooms?", "Kitchen, attic"],
        ["retired_key", "Kept as typed"],
      ],
    ],
    [
      "es",
      [
        ["¿Dónde está la fuga?", "Under the sink"],
        ["¿Es urgente?", "Sí"],
        ["¿Qué cuartos?", "Cocina, attic"],
        ["retired_key", "Kept as typed"],
      ],
    ],
  ])("are in the category's words, in the reader's language (%s)", async (locale, expected) => {
    const categories = [{ ...CATEGORIES[0], intake_questions: QUESTIONS }];
    // Past Classify (quote_ready): the categories are read for the answers alone.
    api(card({ status: "quote_ready", intake_answers: ANSWERS }), "agent", locale, categories);

    const pairs = facts(decoded(await markup()));

    // A key or an option the category no longer has stays as it is stored.
    for (const pair of expected) expect(pairs).toContainEqual(pair);
  });

  it("stay as stored when the catalog cannot be read", async () => {
    api(card({ intake_answers: ANSWERS }));
    fetchMock.mockImplementation(
      routeFetch({
        "/v1/auth/me": () => me("agent", "en"),
        [CARD]: () => Response.json(card({ intake_answers: ANSWERS })),
        "/v1/categories": () => new Response(null, { status: 503 }),
      }),
    );

    const pairs = facts(decoded(await markup()));

    expect(pairs).toContainEqual(["leak_location", "Under the sink"]);
    expect(pairs).toContainEqual(["urgent", "true"]);
    expect(pairs).toContainEqual(["rooms", "kitchen, attic"]);
  });
});
