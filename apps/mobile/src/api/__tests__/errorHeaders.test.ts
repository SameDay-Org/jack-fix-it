import { apiPost } from "../client";
import { ApiError } from "../errors";
import { sendRequest } from "../http";
import { errorResponse, installFetchMock, jsonResponse, type FetchMock } from "./helpers";

jest.mock("../config", () => jest.requireActual("./helpers").configMock);
jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock);

const JOB_ID = "00000000-0000-4000-8000-000000000630";
const CHECK_IN = "/v1/pros/me/jobs/{job_id}/check-in";
const TRIES_HEADER = "Arrival-Code-Attempts-Remaining";
const BODY = { arrival_code: "4821", lat: 26.1, lng: -80.1 };

/** The error a promise rejected with, or a failure when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
}

const asApiError = (error: unknown): ApiError => {
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
};

describe("ApiError.header", () => {
  it("reads a header of the error answer whatever case the name is written in", () => {
    const error = new ApiError(422, "arrival_code_invalid", new Headers({ [TRIES_HEADER]: "3" }));

    expect(error.header(TRIES_HEADER)).toBe("3");
    expect(error.header("arrival-code-attempts-remaining")).toBe("3");
    expect(error.header("ARRIVAL-CODE-ATTEMPTS-REMAINING")).toBe("3");
  });

  it("answers null for a header the answer did not send", () => {
    const error = new ApiError(422, "arrival_code_invalid", new Headers({ "X-Other": "1" }));

    expect(error.header(TRIES_HEADER)).toBeNull();
  });

  it("answers null when the error carries no headers at all", () => {
    expect(new ApiError(409, "check_in_required").header(TRIES_HEADER)).toBeNull();
    expect(new ApiError(500, undefined).header(TRIES_HEADER)).toBeNull();
  });

  it("keeps an empty header value as an empty string, not as a missing one", () => {
    const error = new ApiError(422, "arrival_code_invalid", new Headers({ [TRIES_HEADER]: "" }));

    expect(error.header(TRIES_HEADER)).toBe("");
  });
});

describe("sendRequest error headers", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it("puts the error answer's headers on the ApiError beside its status and code", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(422, "arrival_code_invalid", { [TRIES_HEADER]: "2" }),
    );

    const error = asApiError(
      await rejection(sendRequest("POST", CHECK_IN, { params: { job_id: JOB_ID }, body: BODY })),
    );

    expect(error.status).toBe(422);
    expect(error.code).toBe("arrival_code_invalid");
    expect(error.header(TRIES_HEADER)).toBe("2");
    expect(error.header("arrival-code-attempts-remaining")).toBe("2");
  });

  it("answers null for a header an error answer did not send", async () => {
    fetchMock.mockResolvedValue(errorResponse(423, "arrival_code_locked"));

    const error = asApiError(
      await rejection(sendRequest("POST", CHECK_IN, { params: { job_id: JOB_ID }, body: BODY })),
    );

    expect(error.status).toBe(423);
    expect(error.header(TRIES_HEADER)).toBeNull();
  });

  it("keeps the headers of an error answer whose body is not JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, undefined, { "Retry-After": "30" }));

    const error = asApiError(await rejection(sendRequest("GET", "/health")));

    expect(error.status).toBe(503);
    expect(error.code).toBeUndefined();
    expect(error.header("retry-after")).toBe("30");
  });

  it("hands the headers through the client's apiPost unchanged", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(422, "arrival_code_invalid", { [TRIES_HEADER]: "1" }),
    );

    const error = asApiError(
      await rejection(apiPost(CHECK_IN, BODY, { params: { job_id: JOB_ID } })),
    );

    expect(error.code).toBe("arrival_code_invalid");
    expect(error.header(TRIES_HEADER)).toBe("1");
  });
});
