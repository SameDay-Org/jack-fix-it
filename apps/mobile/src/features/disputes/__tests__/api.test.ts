import { ApiError, NetworkError, SessionExpiredError } from "@/api";

import { sendFailureOf } from "../api";
import { DEFAULT_PHOTO_MAX, readPhotoMax } from "../config";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

describe("sendFailureOf", () => {
  it.each([
    ["no connection", new NetworkError(false), "offline"],
    ["not disputable", new ApiError(409, "job_not_disputable"), "closed"],
    ["the key reused", new ApiError(409, "idempotency_key_reused"), "closed"],
    ["invalid", new ApiError(422, "validation_error"), "invalid"],
    ["a server error", new ApiError(503, "unavailable"), "failed"],
    ["not theirs", new ApiError(404, "not_found"), "failed"],
    ["anything else", new Error("boom"), "failed"],
  ])("maps %s to calm copy", (_, error, failure) => {
    expect(sendFailureOf(error)).toBe(failure);
  });

  it("leaves an ended session to the sign-out handling", () => {
    expect(sendFailureOf(new SessionExpiredError())).toBeNull();
  });
});

describe("readPhotoMax", () => {
  it("mirrors the API's DISPUTE_PHOTO_MAX_COUNT, 10 when unset", () => {
    expect(readPhotoMax(undefined)).toBe(DEFAULT_PHOTO_MAX);
    expect(readPhotoMax(" ")).toBe(DEFAULT_PHOTO_MAX);
    expect(readPhotoMax("4")).toBe(4);
  });

  it.each(["0", "-1", "2.5", "ten"])("refuses %s", (raw) => {
    expect(() => readPhotoMax(raw)).toThrow("EXPO_PUBLIC_DISPUTE_PHOTO_MAX_COUNT");
  });
});
