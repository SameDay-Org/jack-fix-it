import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiGet, apiPatch, apiUrl } from "./api";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("apiGet", () => {
  it("returns the typed JSON body", async () => {
    fetchMock.mockResolvedValue(Response.json({ status: "ok" }));

    const body = await apiGet("/health");

    expect(body.status).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test.invalid:8000/health");
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
  });

  it("throws ApiError with the error code from the error contract", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code: "not_found", message: "Not Found." } }, { status: 404 }),
    );

    await expect(apiGet("/health")).rejects.toMatchObject(new ApiError(404, "not_found"));
  });

  it("throws when API_INTERNAL_URL is missing", async () => {
    vi.stubEnv("API_INTERNAL_URL", "");

    await expect(apiGet("/health")).rejects.toThrow("API_INTERNAL_URL is not set");
  });

  it("throws when API_TIMEOUT_MS is missing", async () => {
    vi.stubEnv("API_TIMEOUT_MS", "");

    await expect(apiGet("/health")).rejects.toThrow("API_TIMEOUT_MS");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const TICKET_ID = "0f3a5c1e-1111-4222-8333-944455556666";
const TICKET_PATH = "/v1/admin/support/tickets/{ticket_id}";

describe("apiUrl", () => {
  it("fills the path's placeholders and appends the query that is set", () => {
    const url = apiUrl(TICKET_PATH, {
      params: { ticket_id: TICKET_ID },
      query: { status: "open", cursor: "a b&c=d", limit: undefined, other: null },
    });

    expect(url.pathname).toBe(`/v1/admin/support/tickets/${TICKET_ID}`);
    expect([...url.searchParams]).toEqual([
      ["status", "open"],
      ["cursor", "a b&c=d"],
    ]);
  });

  it("encodes a value so it stays one path segment", () => {
    const url = apiUrl(TICKET_PATH, { params: { ticket_id: "../../auth/me?x=1#y" } });

    expect(url.pathname).toBe("/v1/admin/support/tickets/..%2F..%2Fauth%2Fme%3Fx%3D1%23y");
    expect(url.search).toBe("");
  });

  it.each([undefined, "", ".", ".."])("refuses a placeholder left as %j", (value) => {
    expect(() => apiUrl(TICKET_PATH, { params: { ticket_id: value } })).toThrow("ticket_id");
  });
});

describe("apiGet with a path parameter and a query", () => {
  it("requests the filled URL and keeps the caller's headers", async () => {
    fetchMock.mockResolvedValue(Response.json({ items: [], next_cursor: null }));

    await apiGet("/v1/admin/support/tickets", {
      headers: { Authorization: "Bearer at-1" },
      query: { status: "closed", cursor: null },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test.invalid:8000/v1/admin/support/tickets?status=closed");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer at-1");
    // The URL parts are this client's own: fetch never receives them.
    expect(init).not.toHaveProperty("query");
    expect(init).not.toHaveProperty("params");
  });
});

describe("apiPatch", () => {
  it("sends the JSON body to the filled path and returns the typed body", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: TICKET_ID, status: "closed" }));

    const ticket = await apiPatch(
      TICKET_PATH,
      { status: "closed" },
      { headers: { Authorization: "Bearer at-1" }, params: { ticket_id: TICKET_ID } },
    );

    expect(ticket.status).toBe("closed");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://api.test.invalid:8000/v1/admin/support/tickets/${TICKET_ID}`);
    expect(init?.method).toBe("PATCH");
    expect(init?.cache).toBe("no-store");
    expect(JSON.parse(String(init?.body))).toEqual({ status: "closed" });
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer at-1");
  });

  it("throws ApiError with the error code from the error contract", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code: "ticket_not_found", message: "x" } }, { status: 404 }),
    );

    await expect(
      apiPatch(TICKET_PATH, { status: "open" }, { params: { ticket_id: TICKET_ID } }),
    ).rejects.toMatchObject(new ApiError(404, "ticket_not_found"));
  });
});
