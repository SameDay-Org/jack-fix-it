import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The visitor's request headers, as next/headers gives them to an action.
const { request } = vi.hoisted(() => ({ request: { headers: new Headers() } }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { checkFormToken, mintFormToken } from "@/lib/public-form/form-token";

import { interestToken, joinInterest } from "./actions";
import { INTEREST_CONSENT_VERSION } from "./config";
import type { InterestInput } from "./types";

const fetchMock = vi.fn<typeof fetch>();
const FORM_SECRET = "interest-secret-for-tests-0123456789ab";
const WEB_KEY = "web-service-key-for-tests-0123456789";
const TIMINGS = { minSeconds: 3, maxAgeSeconds: 7200 };

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: "m" } }, { status });
}

/** A token old enough to send, as a visitor typing their email for a minute would hold. */
const ready = () => mintFormToken(FORM_SECRET, "interest", Date.now(), 60);

function input(patch: Partial<InterestInput> = {}): InterestInput {
  return { token: ready(), website: "", email: " Ana@Example.com ", locale: "es", ...patch };
}

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("INTEREST_FORM_ENABLED", "true");
  vi.stubEnv("INTEREST_FORM_SECRET", FORM_SECRET);
  vi.stubEnv("WEB_SERVICE_KEY", WEB_KEY);
  vi.stubEnv("CLIENT_IP_HEADER", "x-forwarded-for");
  vi.stubEnv("INTEREST_FORM_MIN_SECONDS", "");
  vi.stubEnv("INTEREST_FORM_MAX_AGE_SECONDS", "");
  // The edge appended the visitor's address last; what the client put before it is ignored.
  request.headers = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("with INTEREST_FORM_ENABLED off", () => {
  // A server action can be POSTed directly whatever the page renders: each checks the flag
  // first, and does nothing.
  it.each(["", "false", "1", "TRUE"])("%j: no token, no list write", async (value) => {
    vi.stubEnv("INTEREST_FORM_ENABLED", value);
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await expect(interestToken()).resolves.toBeNull();
    await expect(joinInterest(input())).resolves.toEqual({ kind: "error", error: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("interestToken", () => {
  it("gives a token for this form only", async () => {
    const token = await interestToken();
    const later = Date.now() + 10_000;
    expect(checkFormToken(token, FORM_SECRET, "interest", later, TIMINGS).ok).toBe(true);
    expect(checkFormToken(token, FORM_SECRET, "request", later, TIMINGS).ok).toBe(false);
  });

  it("fails without its secrets: a form that cannot be sent is not served", async () => {
    vi.stubEnv("INTEREST_FORM_SECRET", "short");
    await expect(interestToken()).rejects.toThrow(/INTEREST_FORM_SECRET/);
  });
});

describe("joinInterest", () => {
  it("puts the email on the list with the consent's version, the key and the visitor's address", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await expect(joinInterest(input())).resolves.toEqual({ kind: "joined" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test.invalid:8000/v1/interest");
    expect(init?.method).toBe("POST");
    expect(init?.cache).toBe("no-store");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "ana@example.com",
      locale: "es",
      source: "showcase",
      consent_version: INTEREST_CONSENT_VERSION,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("x-jfi-web-key")).toBe(WEB_KEY);
    expect(headers.get("x-jfi-client-ip")).toBe("203.0.113.7");
  });

  it("takes any success as on the list, whatever its body", async () => {
    for (const response of [
      new Response(null, { status: 202 }),
      Response.json({ ok: true }, { status: 201 }),
      new Response("", { status: 200 }),
    ]) {
      fetchMock.mockResolvedValueOnce(response);
      await expect(joinInterest(input())).resolves.toEqual({ kind: "joined" });
    }
  });

  it("drops a filled trap without a call, says joined and logs only a counter", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(joinInterest(input({ website: "https://spam.example" }))).resolves.toEqual({
      kind: "joined",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("interest_honeypot");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/spam|ana@/i);
    log.mockRestore();
  });

  it("refuses a send right after the token was given, without a call or a new token", async () => {
    await expect(
      joinInterest(input({ token: mintFormToken(FORM_SECRET, "interest") })),
    ).resolves.toEqual({ kind: "error", error: "retry" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives an old, forged or other-form token a fresh one, ready to send", async () => {
    for (const token of [
      mintFormToken(FORM_SECRET, "interest", Date.now(), 7201),
      mintFormToken("another-secret-0123456789abcdef0123", "interest", Date.now(), 60),
      mintFormToken(FORM_SECRET, "request", Date.now(), 60),
      "",
    ]) {
      const result = await joinInterest(input({ token }));
      expect(result).toMatchObject({ kind: "error", error: "stale" });
      const fresh = result.kind === "error" ? result.token : undefined;
      expect(checkFormToken(fresh, FORM_SECRET, "interest", Date.now(), TIMINGS).ok).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the email again: not an address, no call", async () => {
    for (const email of ["", "ana@", "<b>@x", "a".repeat(330)]) {
      await expect(joinInterest(input({ email })), email).resolves.toEqual({
        kind: "error",
        error: "invalid_email",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends English for a language it does not know", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await joinInterest(input({ locale: "pt" as InterestInput["locale"] }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ locale: "en" });
  });

  it.each([
    [apiError(422, "validation_error"), "invalid_email"],
    [apiError(429, "rate_limited"), "rate_limited"],
    [apiError(404, "not_found"), "unavailable"],
    [apiError(503, "unavailable"), "unavailable"],
  ] as const)("answers the API's refusal as a code the page words", async (response, error) => {
    fetchMock.mockResolvedValueOnce(response);
    await expect(joinInterest(input())).resolves.toEqual({ kind: "error", error });
  });

  it("passes on the API's wait after too many tries, in whole minutes rounded up", async () => {
    for (const [retryAfter, waitMinutes] of [
      ["1", 1],
      ["60", 1],
      ["61", 2],
      ["3600", 60],
    ] as const) {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          { error: { code: "rate_limited", message: "m" } },
          { status: 429, headers: { "Retry-After": retryAfter } },
        ),
      );
      await expect(joinInterest(input()), retryAfter).resolves.toEqual({
        kind: "error",
        error: "rate_limited",
        waitMinutes,
      });
    }
    // A wait on any other refusal is not the visitor's to see.
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code: "unavailable", message: "m" } },
        { status: 503, headers: { "Retry-After": "30" } },
      ),
    );
    await expect(joinInterest(input())).resolves.toEqual({ kind: "error", error: "unavailable" });
  });

  it("answers a refused key as unavailable and logs only that it happened", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(apiError(401, "invalid_service_key"));
    await expect(joinInterest(input())).resolves.toEqual({ kind: "error", error: "unavailable" });
    expect(log).toHaveBeenCalledWith("interest_join_unauthorized");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ana@/i);
    log.mockRestore();
  });

  it("answers unavailable when the API cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(joinInterest(input())).resolves.toEqual({ kind: "error", error: "unavailable" });
  });
});
