import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiGet } from "./api";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
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
});
