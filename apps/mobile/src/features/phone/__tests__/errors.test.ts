import i18n from "@/i18n";

import { ApiError, NetworkError, SessionExpiredError } from "../../../api/errors";
import { describePhoneFailure } from "../errors";

jest.mock("@/api", () => jest.requireActual("../../../api/errors"));

const say = (error: unknown) => i18n.t(describePhoneFailure(error), { lng: "en" });

describe("describePhoneFailure", () => {
  it("maps each contract code to its own message, never the server text", () => {
    expect(say(new ApiError(400, "invalid_code"))).toBe(
      "That code isn't right. Check it and try again.",
    );
    expect(say(new ApiError(409, "phone_unavailable"))).toBe(
      "This number can't be used. Try another one.",
    );
    expect(say(new ApiError(429, "rate_limited"))).toBe(
      "Too many attempts. Try again in a moment.",
    );
    expect(say(new ApiError(503, "verification_unavailable"))).toBe(
      "We couldn't send or check the code right now. Try again soon.",
    );
    expect(say(new ApiError(422, "validation_error"))).toBe(
      "Enter a valid 10-digit US phone number.",
    );
  });

  it("no connection gets the connection message from sign-in", () => {
    expect(say(new NetworkError(false))).toBe("No connection. Check your internet and try again.");
    expect(say(new NetworkError(true))).toBe("No connection. Check your internet and try again.");
  });

  it("anything else gets the generic line", () => {
    expect(say(new ApiError(500, undefined))).toBe("Something went wrong. Try again.");
    expect(say(new ApiError(418, "teapot"))).toBe("Something went wrong. Try again.");
    expect(say(new SessionExpiredError())).toBe("Something went wrong. Try again.");
    expect(say(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
