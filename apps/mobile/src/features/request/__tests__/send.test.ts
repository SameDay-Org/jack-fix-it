import { ApiError, NetworkError, SessionExpiredError } from "@/api";

import { requestBody, sendFailureOf } from "../send";
import { PAINTING } from "./helpers";
import type { RequestDraft } from "../requestDraft";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

const DRAFT: RequestDraft = {
  categorySlug: "painting",
  answers: { surface: "ceiling" },
  description: "  Water stain on the ceiling  ",
  address: null,
  typedAddress: { line1: "", line2: "", city: "", state: "", zipCode: "" },
  preferredDate: null,
  refusal: null,
};

const ADDRESS = {
  line1: "12 Main St",
  line2: null,
  city: "Newark",
  state: "NJ",
  zip_code: "07102",
};

describe("requestBody", () => {
  it("builds the exact RequestCreate: the category's id, answers by key, media keys in order, no date", () => {
    expect(
      requestBody({
        draft: DRAFT,
        category: PAINTING,
        address: ADDRESS,
        mediaKeys: ["uploads/b.jpg", "uploads/a.mp4"],
      }),
    ).toStrictEqual({
      category_id: PAINTING.id,
      description: "Water stain on the ceiling",
      address: ADDRESS,
      intake_answers: { surface: "ceiling", furnished: false },
      media_keys: ["uploads/b.jpg", "uploads/a.mp4"],
    });
  });
  it("sends the chosen day as YYYY-MM-DD and leaves it out when flexible", () => {
    const parts = { category: PAINTING, address: ADDRESS, mediaKeys: [] };
    expect(
      requestBody({ ...parts, draft: { ...DRAFT, preferredDate: "2026-11-03" } }).preferred_date,
    ).toBe("2026-11-03");
    expect(requestBody({ ...parts, draft: DRAFT })).not.toHaveProperty("preferred_date");
  });
});

describe("sendFailureOf", () => {
  it("sends the server's step refusals back to the step that can fix them", () => {
    expect(sendFailureOf(new ApiError(422, "zip_not_served"))).toEqual({
      kind: "step",
      refusal: { step: "where", reason: "zipNotServed" },
    });
    expect(sendFailureOf(new ApiError(422, "invalid_media"))).toEqual({
      kind: "step",
      refusal: { step: "describe", reason: "invalidMedia" },
    });
    expect(sendFailureOf(new ApiError(422, "invalid_intake_answers"))).toEqual({
      kind: "step",
      refusal: { step: "questions", reason: "invalidAnswers" },
    });
  });

  it("offers a retry for the network, 5xx and 429; anything else is a refusal off the steps", () => {
    expect(sendFailureOf(new NetworkError(true))).toEqual({ kind: "retry", reason: "failed" });
    expect(sendFailureOf(new ApiError(503, undefined))).toEqual({
      kind: "retry",
      reason: "failed",
    });
    expect(sendFailureOf(new ApiError(429, "rate_limited"))).toEqual({
      kind: "retry",
      reason: "rateLimited",
    });
    expect(sendFailureOf(new ApiError(422, "validation_error"))).toEqual({ kind: "rejected" });
    expect(sendFailureOf(new SessionExpiredError())).toEqual({ kind: "signedOut" });
  });
});
