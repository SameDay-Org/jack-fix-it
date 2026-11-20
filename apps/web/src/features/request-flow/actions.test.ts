import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { routeFetch } from "@/lib/test-helpers";

import { checkZip, joinWaitlist } from "./actions";
import type { WaitlistInput } from "./types";

const fetchMock = vi.fn<typeof fetch>();
const CATEGORY = "6b3c0e1d-1111-4222-8333-944455556666";

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: "m" } }, { status });
}

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubEnv("REQUEST_FLOW_ENABLED", "true");
  vi.stubEnv("PHONE_COUNTRY_CODE", "");
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
  it.each(["", "false", "1", "TRUE"])("%j: no ZIP check and no waitlist write", async (value) => {
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
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("checkZip", () => {
  it("asks the API and answers served or not, with the 5-digit ZIP it checked", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ zip_code: "33301", served: true }));
    await expect(checkZip("33301-1234")).resolves.toEqual({ kind: "served", zip: "33301" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test.invalid:8000/v1/service-areas/check?zip=33301-1234");
    expect(init?.cache).toBe("no-store");

    fetchMock.mockResolvedValueOnce(Response.json({ zip_code: "99999", served: false }));
    await expect(checkZip(" 99999 ")).resolves.toEqual({ kind: "not_served", zip: "99999" });
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
