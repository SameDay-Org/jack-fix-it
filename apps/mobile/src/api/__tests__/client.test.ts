import { apiGet, apiPost } from "../client";
import { ApiError, NetworkError } from "../errors";
import type { GetPath } from "../http";
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

    await expect(
      apiGet("https://evil.invalid/v1/auth/me" as GetPath, { auth: true }),
    ).rejects.toThrow(/outside the configured API host/);
    await expect(apiGet("//evil.invalid/v1/auth/me" as GetPath, { auth: true })).rejects.toThrow(
      /outside the configured API host/,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
