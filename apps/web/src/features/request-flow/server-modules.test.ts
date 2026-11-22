import { afterEach, describe, expect, it, vi } from "vitest";

import { utmFromSearch, utmInput } from "./attribution";
import { requestFlowSecrets, storeLinks } from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("attribution: the utm keys", () => {
  it("keeps the five keys that are set and fit, and nothing else", () => {
    expect(
      utmFromSearch({
        utm_source: " google ",
        utm_medium: "cpc",
        utm_campaign: ["a", "b"],
        utm_term: "x".repeat(101),
        utm_content: "line\nbreak",
        utm_id: "123",
        gclid: "abc",
      }),
    ).toEqual({ source: "google", medium: "cpc" });
    expect(utmFromSearch({})).toBeNull();
    expect(utmInput({ source: 42, campaign: "launch" } as never)).toEqual({ campaign: "launch" });
    expect(utmInput(null)).toBeNull();
  });
});

describe("config", () => {
  it("needs both secrets", () => {
    vi.stubEnv("REQUEST_FORM_SECRET", "f".repeat(32));
    vi.stubEnv("WEB_SERVICE_KEY", "k".repeat(32));
    expect(requestFlowSecrets()).toEqual({
      formSecret: "f".repeat(32),
      webServiceKey: "k".repeat(32),
    });
    vi.stubEnv("WEB_SERVICE_KEY", "k".repeat(31));
    expect(() => requestFlowSecrets()).toThrow(/WEB_SERVICE_KEY/);
    vi.stubEnv("REQUEST_FORM_SECRET", "");
    expect(() => requestFlowSecrets()).toThrow(/REQUEST_FORM_SECRET/);
  });

  it("offers the stores only with both https links", () => {
    vi.stubEnv("APP_STORE_URL", "https://apps.example/jack");
    vi.stubEnv("PLAY_STORE_URL", "");
    expect(storeLinks()).toBeNull();
    vi.stubEnv("PLAY_STORE_URL", "http://play.example/jack");
    expect(storeLinks()).toBeNull();
    vi.stubEnv("PLAY_STORE_URL", "https://play.example/jack");
    expect(storeLinks()).toEqual({
      appStore: "https://apps.example/jack",
      playStore: "https://play.example/jack",
    });
  });
});
