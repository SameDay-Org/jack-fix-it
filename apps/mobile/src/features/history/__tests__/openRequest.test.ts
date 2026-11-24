import i18n from "@/i18n";

import { pickOpenRequest, requestBannerParts } from "../openRequest";
import type { RequestSummary } from "../useMyRequests";

const request = (n: number, status: RequestSummary["status"]): RequestSummary => ({
  id: `6f1c2a40-0000-4000-8000-00000000047${n}`,
  public_code: `JF-00047${n}`,
  status,
  customer_status: "customerStatus.findingAPro",
  category_id: null,
  created_at: "2026-11-19T06:00:00Z",
  media_count: 0,
});

afterEach(() => i18n.changeLanguage("en"));

describe("pickOpenRequest (#474)", () => {
  it("is null with no request, or none still open", () => {
    expect(pickOpenRequest([])).toBeNull();
    expect(
      pickOpenRequest([request(1, "accepted"), request(2, "expired"), request(3, "cancelled")]),
    ).toBeNull();
  });

  it("is the newest open request (the list comes newest first)", () => {
    const newest = request(1, "received");
    expect(pickOpenRequest([newest, request(2, "finding_pro")])).toBe(newest);
    expect(pickOpenRequest([request(1, "cancelled"), request(2, "reviewing")])?.status).toBe(
      "reviewing",
    );
  });

  it("puts a quote ready first, even behind newer requests still waiting", () => {
    const ready = request(3, "quote_ready");
    expect(pickOpenRequest([request(1, "finding_pro"), request(2, "received"), ready])).toBe(ready);
  });

  it("leaves an accepted request to the quote screen and the job banner", () => {
    expect(pickOpenRequest([request(1, "accepted"), request(2, "finding_pro")])?.status).toBe(
      "finding_pro",
    );
  });
});

describe("requestBannerParts (#474)", () => {
  it.each([
    ["received", "John got your request"],
    ["reviewing", "John got your request"],
    ["finding_pro", "John is finding a pro"],
  ] as const)("%s: one short line, nothing to do", (status, line) => {
    expect(requestBannerParts(i18n.t, request(1, status))).toEqual({
      main: line,
      tail: null,
      label: line,
    });
  });

  it("a quote ready ends with the action, read together", () => {
    expect(requestBannerParts(i18n.t, request(1, "quote_ready"))).toEqual({
      main: "Quote ready",
      tail: "compare",
      label: "Quote ready · compare",
    });
  });

  it("speaks Spanish in Spanish", async () => {
    await i18n.changeLanguage("es");
    expect(requestBannerParts(i18n.t, request(1, "quote_ready")).label).toBe(
      "Presupuesto listo · comparar",
    );
    expect(requestBannerParts(i18n.t, request(1, "finding_pro")).main).toBe(
      "John busca un profesional",
    );
  });
});
