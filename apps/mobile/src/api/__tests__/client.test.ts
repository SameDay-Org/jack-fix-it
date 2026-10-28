import { apiGet, apiPost } from "../client";
import { ApiError, NetworkError } from "../errors";
import { sessionStore } from "../session";
import {
  API_ORIGIN,
  callHeader,
  errorResponse,
  installFetchMock,
  jsonResponse,
  neverAnswers,
  user,
  watchConsole,
  type FetchMock,
} from "./helpers";

jest.mock("../config", () => jest.requireActual("./helpers").configMock);
jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock);

/** A string that reached the client at runtime, typed as a GET path without parameters. */
const asPath = (url: string) => url as "/v1/auth/me";

let fetchMock: FetchMock;
let consoleWatch: ReturnType<typeof watchConsole>;

beforeEach(() => {
  fetchMock = installFetchMock();
  consoleWatch = watchConsole();
});

afterEach(() => {
  consoleWatch.assertNoTokenLogged();
  consoleWatch.restore();
  jest.useRealTimers();
});

describe("apiGet / apiPost", () => {
  it("parses typed JSON on 2xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

    const body = await apiGet("/health");

    expect(body.status).toBe("ok");
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe(`${API_ORIGIN}/health`);
    expect(call[1]?.method).toBe("GET");
    expect(callHeader(call, "Accept")).toBe("application/json");
    expect(callHeader(call, "Authorization")).toBeUndefined();
  });

  it("handles 204 with no body", async () => {
    const response = jsonResponse(204);
    const json = jest.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);

    await expect(
      apiPost("/v1/auth/logout", { refresh_token: "refresh-x" }),
    ).resolves.toBeUndefined();

    expect(json).not.toHaveBeenCalled();
    expect(callHeader(fetchMock.mock.calls[0], "Content-Type")).toBe("application/json");
  });

  it("handles a 202 with no body (an accepted request, like the SMS code send)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202));

    await expect(
      apiPost("/v1/auth/phone/send", { phone: "+14155550123" }),
    ).resolves.toBeUndefined();
  });

  it("a 202 whose body is not empty and not JSON is a malformed answer, not an acceptance", async () => {
    fetchMock.mockResolvedValue({
      status: 202,
      ok: true,
      text: async () => "{broken",
      json: async () => {
        throw new SyntaxError("invalid JSON");
      },
    } as unknown as Response);

    await expect(apiPost("/v1/auth/phone/send", { phone: "+13055550123" })).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("malformed JSON on a 200 is rejected too", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => "{broken",
      json: async () => {
        throw new SyntaxError("invalid JSON");
      },
    } as unknown as Response);

    await expect(apiGet("/health")).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([400, 409, 429, 500])(
    "an empty %i is an ApiError, never an acceptance",
    async (status) => {
      fetchMock.mockResolvedValue(jsonResponse(status));

      await expect(apiPost("/v1/auth/phone/send", { phone: "+13055550123" })).rejects.toMatchObject(
        {
          name: "ApiError",
          status,
        },
      );
    },
  );

  it("parses a 202 that does carry JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { status: "ok" }));

    await expect(apiGet("/health")).resolves.toEqual({ status: "ok" });
  });

  it("throws ApiError with the contract code on 4xx", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "not_found"));

    await expect(apiGet("/health")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "not_found",
    });
  });

  it("reports a 5xx without a contract body as ApiError with no code", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503));

    await expect(apiGet("/health")).rejects.toEqual(new ApiError(503, undefined));
  });

  it("throws NetworkError on timeout", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(neverAnswers);

    const request = apiGet("/health");
    const outcome = expect(request).rejects.toMatchObject({ name: "NetworkError", timedOut: true });
    await jest.advanceTimersByTimeAsync(15_000);

    await outcome;
  });

  it("throws NetworkError when the network fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));

    await expect(apiGet("/health")).rejects.toBeInstanceOf(NetworkError);
    await expect(apiGet("/health")).rejects.toMatchObject({ timedOut: false });
  });

  it("a pre-aborted request sends nothing", async () => {
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(apiGet("/health", { signal: cancelled.signal })).rejects.toMatchObject({
      name: "AbortError",
    });

    sessionStore.setState({
      status: "signedIn",
      user,
      accessToken: "access-1",
      accessTokenExpiresAt: Date.now() + 900_000,
      cleanupPending: false,
    });
    await expect(
      apiGet("/v1/auth/me", { auth: true, signal: cancelled.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends Authorization to another host", async () => {
    sessionStore.setState({
      status: "signedIn",
      user,
      accessToken: "access-1",
      accessTokenExpiresAt: Date.now() + 900_000,
      cleanupPending: false,
    });

    await expect(apiGet(asPath("https://evil.invalid/v1/auth/me"), { auth: true })).rejects.toThrow(
      /outside the configured API host/,
    );
    await expect(apiGet(asPath("//evil.invalid/v1/auth/me"), { auth: true })).rejects.toThrow(
      /outside the configured API host/,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("path parameters", () => {
  const QUOTES = "/v1/requests/{request_id}/quotes";

  it("fills each one, encoded as exactly one segment", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));

    await apiGet(QUOTES, { params: { request_id: "a/b?c#d e" } });

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_ORIGIN}/v1/requests/a%2Fb%3Fc%23d%20e/quotes`);
  });

  it.each(["..", ".", ""])("refuses %j and sends nothing", async (value) => {
    await expect(apiGet(QUOTES, { params: { request_id: value } })).rejects.toThrow(
      'Invalid value for the path parameter "request_id"',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts with no body and no Content-Type to a path that takes none", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await apiPost("/v1/requests/{request_id}/quotes/{quote_id}/accept", undefined, {
      params: { request_id: "r-1", quote_id: "q-1" },
    });

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe(`${API_ORIGIN}/v1/requests/r-1/quotes/q-1/accept`);
    expect(call[1]?.method).toBe("POST");
    expect(call[1]?.body).toBeUndefined();
    expect(callHeader(call, "Content-Type")).toBeUndefined();
  });

  // Signed in, with a value as a deep link could hand it over: the bearer token goes with the
  // request only because the final URL is on the configured host, so each one must stay there.
  describe("signed in, a crafted value stays one segment on the configured host", () => {
    const ACCEPT = "/v1/requests/{request_id}/quotes/{quote_id}/accept";

    beforeEach(() => {
      sessionStore.setState({
        status: "signedIn",
        user,
        accessToken: "access-1",
        accessTokenExpiresAt: Date.now() + 900_000,
        cleanupPending: false,
      });
      fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));
    });

    it.each([
      ["an encoded slash", "a%2Fb", "a%252Fb"],
      ["an encoded dot-dot", "%2e%2e", "%252e%252e"],
      ["a backslash", "a\\b", "a%5Cb"],
      ["Unicode", "ñandú 日本", "%C3%B1and%C3%BA%20%E6%97%A5%E6%9C%AC"],
      [
        "an absolute URL",
        "https://evil.invalid/v1/auth/me",
        "https%3A%2F%2Fevil.invalid%2Fv1%2Fauth%2Fme",
      ],
      [
        "a protocol-relative URL",
        "//evil.invalid/v1/auth/me",
        "%2F%2Fevil.invalid%2Fv1%2Fauth%2Fme",
      ],
    ])("%s", async (_, value, segment) => {
      await apiGet(QUOTES, { auth: true, params: { request_id: value } });
      await apiPost(ACCEPT, undefined, {
        auth: true,
        params: { request_id: value, quote_id: "q-1" },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(`${API_ORIGIN}/v1/requests/${segment}/quotes`);
      expect(fetchMock.mock.calls[1][0]).toBe(
        `${API_ORIGIN}/v1/requests/${segment}/quotes/q-1/accept`,
      );
      for (const call of fetchMock.mock.calls) {
        expect(new URL(call[0]).origin).toBe(API_ORIGIN);
        expect(callHeader(call, "Authorization")).toBe("Bearer access-1");
      }
    });

    it("refuses an omitted parameter and sends nothing", async () => {
      // What a runtime caller could pass past the types: one of the path's parameters missing.
      const params = { quote_id: "q-1" } as { request_id: string; quote_id: string };

      await expect(apiPost(ACCEPT, undefined, { auth: true, params })).rejects.toThrow(
        'Invalid value for the path parameter "request_id"',
      );
      await expect(apiGet(QUOTES, { auth: true, params })).rejects.toThrow(
        'Invalid value for the path parameter "request_id"',
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores a harmless extra parameter", async () => {
      // A runtime caller's extra key is neither a segment nor a query string.
      const params = { request_id: "r-1", quote_id: "q-1", extra: "../?x=1" };

      await apiPost(ACCEPT, undefined, { auth: true, params });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(`${API_ORIGIN}/v1/requests/r-1/quotes/q-1/accept`);
      expect(callHeader(fetchMock.mock.calls[0], "Authorization")).toBe("Bearer access-1");
    });
  });
});
