import { ApiError, NetworkError, SessionExpiredError } from "@/api";

import { describeAuthFailure } from "../errors";

jest.mock("../../../api/config", () => ({
  apiConfig: {
    baseUrl: new URL("https://api.test.invalid/"),
    timeoutMs: 15_000,
    passwordMinLength: 10,
  },
}));

describe("describeAuthFailure", () => {
  it.each([
    [401, "invalid_credentials", { messageKey: "auth.errors.invalidCredentials" }],
    [
      409,
      "email_already_registered",
      { messageKey: "auth.errors.emailTaken", highlight: ["email"], offerLogin: true },
    ],
    [403, "account_suspended", { messageKey: "auth.errors.suspended" }],
    [429, "rate_limited", { messageKey: "auth.errors.rateLimited" }],
    [
      422,
      "validation_error",
      { messageKey: "auth.errors.checkFields", highlight: ["email", "password"] },
    ],
  ])("maps %s %s to its catalog key", (status, code, expected) => {
    expect(describeAuthFailure(new ApiError(status, code))).toEqual(expected);
  });

  it("maps a network failure to the connection message", () => {
    expect(describeAuthFailure(new NetworkError(false))).toEqual({
      messageKey: "auth.errors.offline",
    });
    expect(describeAuthFailure(new NetworkError(true))).toEqual({
      messageKey: "auth.errors.offline",
    });
  });

  it("never shows a raw server message: unknown codes and errors get the generic line", () => {
    expect(describeAuthFailure(new ApiError(500, "internal_error"))).toEqual({
      messageKey: "auth.errors.generic",
    });
    expect(describeAuthFailure(new ApiError(400, undefined))).toEqual({
      messageKey: "auth.errors.generic",
    });
    expect(describeAuthFailure(new SessionExpiredError())).toEqual({
      messageKey: "auth.errors.generic",
    });
    expect(describeAuthFailure(new Error("stack trace with secrets"))).toEqual({
      messageKey: "auth.errors.generic",
    });
  });
});
