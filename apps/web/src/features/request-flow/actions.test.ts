import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The visitor's request headers, as next/headers gives them to an action.
const { request } = vi.hoisted(() => ({ request: { headers: new Headers() } }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { checkFormToken, mintFormToken } from "@/lib/public-form/form-token";
import { routeFetch } from "@/lib/test-helpers";

import { checkZip, joinWaitlist, sendRequest } from "./actions";
import { CONSENT_VERSION } from "./config";
import type { RequestDraft, SendInput, WaitlistInput } from "./types";

const fetchMock = vi.fn<typeof fetch>();
const CATEGORY = "6b3c0e1d-1111-4222-8333-944455556666";
const FORM_SECRET = "form-secret-for-tests-0123456789abcdef";
const WEB_KEY = "web-service-key-for-tests-0123456789";
const AREAS = [
  {
    region: "South Florida",
    cities: [
      { city: "Fort Lauderdale", state: "FL", zips: [{ id: "z1", zip_code: "33301" }] },
      { city: "Dania", state: "FL", zips: [{ id: "z2", zip_code: "33004" }] },
      { city: "Hollywood", state: "FL", zips: [{ id: "z3", zip_code: "33004" }] },
    ],
  },
];

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: "m" } }, { status });
}

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REQUEST_FLOW_ENABLED", "true");
  vi.stubEnv("PHONE_COUNTRY_CODE", "");
  vi.stubEnv("REQUEST_FORM_SECRET", FORM_SECRET);
  vi.stubEnv("WEB_SERVICE_KEY", WEB_KEY);
  vi.stubEnv("CLIENT_IP_HEADER", "x-forwarded-for");
  vi.stubEnv("REQUEST_FORM_MIN_SECONDS", "");
  vi.stubEnv("REQUEST_FORM_MAX_AGE_SECONDS", "");
  // The edge appended the visitor's address last; what the client put before it is ignored.
  request.headers = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("with REQUEST_FLOW_ENABLED off (#483 r1)", () => {
  // A server action can be POSTed directly whatever the page renders: each checks the flag
  // first, and calls nothing.
  it.each(["", "false", "1", "TRUE"])(
    "%j: no ZIP check, no waitlist write, no request",
    async (value) => {
      vi.stubEnv("REQUEST_FLOW_ENABLED", value);
      fetchMock.mockResolvedValue(Response.json({ zip_code: "33301", served: true }));
      await expect(checkZip("33301")).resolves.toEqual({ kind: "error", error: "unavailable" });
      await expect(
        joinWaitlist({
          zip: "99999",
          email: "ana@example.com",
          phone: "",
          categoryId: null,
          locale: "en",
        }),
      ).resolves.toEqual({ kind: "error", error: "unavailable" });
      await expect(sendRequest(sendInput())).resolves.toEqual({
        kind: "error",
        error: "unavailable",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("checkZip", () => {
  it("asks the API and answers served or not, with the 5-digit ZIP it checked", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ zip_code: "33301", served: true }))
      .mockResolvedValueOnce(Response.json(AREAS));
    await expect(checkZip("33301-1234")).resolves.toEqual({
      kind: "served",
      zip: "33301",
      city: "Fort Lauderdale",
      state: "FL",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test.invalid:8000/v1/service-areas/check?zip=33301-1234");
    expect(init?.cache).toBe("no-store");
    // The visitor's address and the web service's key go with it (#86 PR A reads them).
    const sent = new Headers(init?.headers);
    expect(sent.get("x-jfi-client-ip")).toBe("203.0.113.7");
    expect(sent.get("x-jfi-web-key")).toBe(WEB_KEY);
    // The served areas, to fill in the city, are read once an hour for everyone: no visitor data.
    const [areasUrl, areasInit] = fetchMock.mock.calls[1]!;
    expect(new URL(String(areasUrl)).pathname).toBe("/v1/service-areas");
    expect((areasInit as RequestInit & { next?: object }).next).toEqual({ revalidate: 3600 });
    expect(new Headers(areasInit?.headers).has("x-jfi-client-ip")).toBe(false);

    fetchMock.mockResolvedValueOnce(Response.json({ zip_code: "99999", served: false }));
    await expect(checkZip(" 99999 ")).resolves.toEqual({ kind: "not_served", zip: "99999" });
  });

  it("fills in no city for a ZIP two cities share, or when the areas cannot be read", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ zip_code: "33004", served: true }))
      .mockResolvedValueOnce(Response.json(AREAS));
    await expect(checkZip("33004")).resolves.toMatchObject({ city: null, state: null });
    fetchMock
      .mockResolvedValueOnce(Response.json({ zip_code: "33301", served: true }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(checkZip("33301")).resolves.toMatchObject({ kind: "served", city: null });
  });

  it("refuses what is not a ZIP without calling the API (a server action is public)", async () => {
    for (const raw of ["", "abc", "3330", { zip: "33301" }, null]) {
      await expect(checkZip(raw)).resolves.toEqual({ kind: "error", error: "invalid" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [apiError(422, "validation_error"), "invalid"],
    [apiError(429, "rate_limited"), "rate_limited"],
    [apiError(500, "internal_error"), "unavailable"],
  ] as const)("answers a refusal as a code the page words", async (response, error) => {
    fetchMock.mockResolvedValueOnce(response);
    await expect(checkZip("33301")).resolves.toEqual({ kind: "error", error });
  });

  it("answers unavailable when the API cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(checkZip("33301")).resolves.toEqual({ kind: "error", error: "unavailable" });
  });
});

describe("joinWaitlist", () => {
  const input = (patch: Partial<WaitlistInput> = {}): WaitlistInput => ({
    zip: "99999",
    email: "",
    phone: "",
    categoryId: null,
    locale: "es",
    ...patch,
  });
  const sent = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call]![1]?.body)) as unknown;

  it("joins from the web with the email and the number in E.164, in the page's language", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await expect(
      joinWaitlist(
        input({ email: " Ana@Example.com ", phone: "(954) 555-0100", categoryId: CATEGORY }),
      ),
    ).resolves.toEqual({ kind: "joined" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test.invalid:8000/v1/waitlist");
    expect(init?.method).toBe("POST");
    expect(sent()).toEqual({
      zip_code: "99999",
      email: "ana@example.com",
      phone: "+19545550100",
      locale: "es",
      source: "web",
      category_id: CATEGORY,
    });
  });

  it("sends the number with PHONE_COUNTRY_CODE, and one contact is enough", async () => {
    vi.stubEnv("PHONE_COUNTRY_CODE", "+1");
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await joinWaitlist(input({ phone: "954 555 0100" }));
    expect(sent()).toMatchObject({ email: null, phone: "+19545550100", category_id: null });
  });

  it.each([
    [input(), "missing_contact"],
    [input({ email: "  ", phone: " " }), "missing_contact"],
    [input({ email: "ana@" }), "invalid_email"],
    [input({ phone: "555-0100" }), "invalid_phone"],
    [input({ email: "ana@example.com", zip: "9999" }), "invalid"],
  ] as const)("refuses %j before calling the API", async (given, error) => {
    await expect(joinWaitlist(given)).resolves.toEqual({ kind: "error", error });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops what it does not know: another language, a category that is not an id", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await joinWaitlist({
      ...input({ email: "ana@example.com", categoryId: "handyman" }),
      locale: "pt" as WaitlistInput["locale"],
    });
    expect(sent()).toMatchObject({ locale: "en", category_id: null });
  });

  it("joins without the service when the API no longer offers it", async () => {
    fetchMock
      .mockResolvedValueOnce(apiError(422, "invalid_category"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    await expect(
      joinWaitlist(input({ email: "ana@example.com", categoryId: CATEGORY })),
    ).resolves.toEqual({ kind: "joined" });
    expect(sent(0)).toMatchObject({ category_id: CATEGORY });
    expect(sent(1)).not.toHaveProperty("category_id");
  });

  it.each([
    [apiError(409, "zip_served"), { kind: "zip_served" }],
    [apiError(422, "validation_error"), { kind: "error", error: "invalid" }],
    [apiError(429, "rate_limited"), { kind: "error", error: "rate_limited" }],
    [apiError(503, "unavailable"), { kind: "error", error: "unavailable" }],
  ] as const)("answers the API's refusal as a code", async (response, result) => {
    fetchMock.mockImplementation(routeFetch({ "/v1/waitlist": () => response.clone() }));
    await expect(joinWaitlist(input({ email: "ana@example.com" }))).resolves.toEqual(result);
  });
});

const DRAFT: RequestDraft = {
  zip: "33301",
  description: "  The kitchen sink leaks.  ",
  categoryId: CATEGORY,
  answers: { rooms: 2, pets: false },
  address: { line1: "100 Las Olas Blvd", line2: "", city: "Fort Lauderdale", state: "fl" },
  date: "2099-03-14",
  period: "morning",
  contact: { firstName: "Ana", phone: "(954) 555-0100", email: "Ana@Example.com" },
  locale: "es",
  utm: { source: "google", campaign: "launch" },
};

/** The API's 201 for a request (POST /v1/web/requests). */
function created(code = "JF-000124"): Response {
  return Response.json({ public_code: code, status: "received" }, { status: 201 });
}

/** A token old enough to send, as a page open for a minute would hold. */
function readyToken(): string {
  return mintFormToken(FORM_SECRET, "request", Date.now(), 60);
}

function sendInput(patch: Partial<SendInput> = {}): SendInput {
  return { token: readyToken(), website: "", draft: DRAFT, ...patch };
}

describe("sendRequest", () => {
  it("sends the checked request with the token's nonce as its Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(created());
    const token = readyToken();
    await expect(sendRequest(sendInput({ token }))).resolves.toEqual({
      kind: "sent",
      code: "JF-000124",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test.invalid:8000/v1/web/requests");
    expect(init?.method).toBe("POST");
    expect(init?.cache).toBe("no-store");
    const headers = new Headers(init?.headers);
    const check = checkFormToken(token, FORM_SECRET, "request", Date.now(), {
      minSeconds: 3,
      maxAgeSeconds: 7200,
    });
    expect(check.ok && headers.get("idempotency-key")).toBe(check.ok ? check.nonce : "");
    expect(headers.get("x-jfi-web-key")).toBe(WEB_KEY);
    expect(headers.get("x-jfi-client-ip")).toBe("203.0.113.7");
    expect(JSON.parse(String(init?.body))).toEqual({
      description: "The kitchen sink leaks.",
      category_id: CATEGORY,
      intake_answers: { rooms: 2, pets: false },
      address: {
        line1: "100 Las Olas Blvd",
        line2: null,
        city: "Fort Lauderdale",
        state: "FL",
        zip_code: "33301",
      },
      preferred_date: "2099-03-14",
      preferred_period: "morning",
      contact: { first_name: "Ana", email: "ana@example.com", phone: "+19545550100" },
      locale: "es",
      utm: { source: "google", campaign: "launch" },
      consent_version: CONSENT_VERSION,
      website: "",
    });
  });

  it("sends the same form twice as one request (the same key)", async () => {
    fetchMock.mockImplementation(async () => created());
    const token = readyToken();
    await sendRequest(sendInput({ token }));
    await sendRequest(sendInput({ token }));
    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("idempotency-key"),
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("drops a filled trap without a call and says sent, with no number", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(sendRequest(sendInput({ website: "https://spam.example" }))).resolves.toEqual({
      kind: "sent",
      code: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // A counter, never the body.
    expect(log).toHaveBeenCalledWith("request_honeypot");
    expect(JSON.stringify(log.mock.calls)).not.toContain("spam.example");
    log.mockRestore();
  });

  it("refuses a send too soon after the page loaded, without a call or a new token", async () => {
    await expect(
      sendRequest(sendInput({ token: mintFormToken(FORM_SECRET, "request") })),
    ).resolves.toEqual({
      kind: "error",
      error: "retry",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives a page left open, or a token it did not sign, a fresh token ready to send", async () => {
    const old = mintFormToken(FORM_SECRET, "request", Date.now(), 7201);
    const forged = mintFormToken("another-secret-0123456789abcdef0123", "request", Date.now(), 60);
    for (const token of [old, forged, "not-a-token", ""]) {
      const result = await sendRequest(sendInput({ token }));
      expect(result).toMatchObject({ kind: "error", error: "stale" });
      const fresh = result.kind === "error" ? result.token : undefined;
      expect(
        checkFormToken(fresh, FORM_SECRET, "request", Date.now(), {
          minSeconds: 3,
          maxAgeSeconds: 7200,
        }).ok,
      ).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks every answer again: a hand-made draft is refused without a call", async () => {
    const drafts: unknown[] = [
      { ...DRAFT, zip: "3330" },
      { ...DRAFT, description: "   " },
      { ...DRAFT, categoryId: "handyman" },
      { ...DRAFT, address: { ...DRAFT.address, state: "Florida" } },
      { ...DRAFT, date: "2000-01-01" },
      { ...DRAFT, contact: { ...DRAFT.contact, phone: "" } },
      { ...DRAFT, contact: { ...DRAFT.contact, email: "" } },
      null,
    ];
    for (const draft of drafts) {
      await expect(
        sendRequest(sendInput({ draft: draft as RequestDraft })),
        JSON.stringify(draft),
      ).resolves.toEqual({ kind: "error", error: "invalid" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    // No request: the API put the contact on the ZIP's waitlist.
    [apiError(409, "out_of_area"), "out_of_area"],
    // This form's key already made a request, with other answers.
    [apiError(409, "idempotency_key_reused"), "duplicate"],
    [apiError(409, "conflict"), "unavailable"],
    [apiError(422, "invalid_category"), "invalid_category"],
    [apiError(422, "invalid_intake_answers"), "invalid_answers"],
    // A phone outside the allowed country codes, or any other field.
    [apiError(422, "validation_error"), "invalid"],
    [apiError(429, "rate_limited"), "rate_limited"],
    [apiError(413, "payload_too_large"), "unavailable"],
    [apiError(404, "not_found"), "unavailable"],
    [apiError(503, "unavailable"), "unavailable"],
  ] as const)("answers the API's refusal as a code the page words", async (response, error) => {
    fetchMock.mockResolvedValueOnce(response);
    await expect(sendRequest(sendInput())).resolves.toEqual({ kind: "error", error });
  });

  it.each([
    ["61", 2],
    ["60", 1],
    ["86400", 1440],
  ] as const)("carries the API's wait (Retry-After %s s) in minutes", async (after, minutes) => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code: "rate_limited", message: "m" } },
        { status: 429, headers: { "Retry-After": after } },
      ),
    );
    await expect(sendRequest(sendInput())).resolves.toEqual({
      kind: "error",
      error: "rate_limited",
      waitMinutes: minutes,
    });
  });

  it("answers a refused key as unavailable and logs only that it happened", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(apiError(401, "invalid_service_key"));
    await expect(sendRequest(sendInput())).resolves.toEqual({
      kind: "error",
      error: "unavailable",
    });
    expect(log).toHaveBeenCalledWith("request_send_unauthorized");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Ana|954|Las Olas/);
    log.mockRestore();
  });

  it("answers unavailable when the API cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(sendRequest(sendInput())).resolves.toEqual({
      kind: "error",
      error: "unavailable",
    });
  });

  it("fails when its secrets are missing: a form that cannot be sent is not served", async () => {
    vi.stubEnv("REQUEST_FORM_SECRET", "short");
    await expect(sendRequest(sendInput())).rejects.toThrow(/REQUEST_FORM_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
