import i18n from "@/i18n";

import {
  DEFAULT_LIVE_MAP_POLL_SECONDS,
  DEFAULT_LIVE_MAP_STALE_SECONDS,
  readLiveMapConfig,
} from "../config";
import { formatMiles, trackingText } from "../tracking";

const raw = (overrides: Partial<Parameters<typeof readLiveMapConfig>[0]> = {}) => ({
  accessToken: "pk.public",
  pollSeconds: undefined,
  staleSeconds: undefined,
  ...overrides,
});

describe("readLiveMapConfig", () => {
  it("polls every 10 s and calls a position old after 60 s by default", () => {
    expect(readLiveMapConfig(raw())).toEqual({
      accessToken: "pk.public",
      pollMs: DEFAULT_LIVE_MAP_POLL_SECONDS * 1000,
      staleMs: DEFAULT_LIVE_MAP_STALE_SECONDS * 1000,
    });
    expect(DEFAULT_LIVE_MAP_POLL_SECONDS).toBe(10);
    expect(DEFAULT_LIVE_MAP_STALE_SECONDS).toBe(60);
  });

  it("takes only a public token: none, blank or secret means no map", () => {
    expect(readLiveMapConfig(raw({ accessToken: undefined })).accessToken).toBeNull();
    expect(readLiveMapConfig(raw({ accessToken: "  " })).accessToken).toBeNull();
    expect(readLiveMapConfig(raw({ accessToken: "sk.secret" })).accessToken).toBeNull();
    expect(readLiveMapConfig(raw({ accessToken: " pk.x " })).accessToken).toBe("pk.x");
  });

  it("refuses timings that are not positive whole seconds", () => {
    expect(() => readLiveMapConfig(raw({ pollSeconds: "0" }))).toThrow(
      "EXPO_PUBLIC_LIVE_MAP_POLL_SECONDS",
    );
    expect(() => readLiveMapConfig(raw({ staleSeconds: "1.5" }))).toThrow(
      "EXPO_PUBLIC_LIVE_MAP_STALE_SECONDS",
    );
    expect(readLiveMapConfig(raw({ pollSeconds: "5", staleSeconds: "90" }))).toMatchObject({
      pollMs: 5000,
      staleMs: 90_000,
    });
  });
});

describe("trackingText", () => {
  const t = i18n.t.bind(i18n);
  const route = {
    geometry: [],
    distance_m: 1931,
    duration_s: 371,
    steps: [{ street_name: "Oak Street", distance_m: 400, duration_s: 60 }],
    computed_at: "2026-11-14T12:00:00Z",
  };

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("says the route's minutes, miles and street, and one sentence for screen readers", () => {
    expect(trackingText(t, { name: "Dan", route, etaMinutes: 40, waiting: false })).toEqual({
      eta: "6 min",
      distance: "1.2 mi",
      street: "Oak Street",
      waiting: false,
      summary: "Dan is 6 min away, on Oak Street",
    });
  });

  it("never says less than a minute, nor a street on an unnamed road", () => {
    const close = { ...route, duration_s: 10, steps: [{ ...route.steps[0], street_name: null }] };
    const text = trackingText(t, { name: "Dan", route: close, etaMinutes: null, waiting: false });
    expect(text.eta).toBe("1 min");
    expect(text.street).toBeNull();
    expect(text.summary).toBe("Dan is 1 min away");
  });

  it("without a route, falls back to the pro's own arrival time, or says they are on the way", () => {
    expect(trackingText(t, { name: "Dan", route: null, etaMinutes: 12, waiting: false })).toEqual(
      expect.objectContaining({ eta: "12 min", distance: null, street: null }),
    );
    expect(
      trackingText(t, { name: "Dan", route: null, etaMinutes: null, waiting: false }).summary,
    ).toBe("Dan is on the way");
  });

  it("says it waits for the location while the position is old", () => {
    expect(trackingText(t, { name: "Dan", route, etaMinutes: null, waiting: true }).summary).toBe(
      "Waiting for Dan's location",
    );
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    expect(trackingText(t, { name: "Dan", route, etaMinutes: null, waiting: false }).summary).toBe(
      "Dan está a 6 min, en Oak Street",
    );
  });

  it("writes whole miles from ten on", () => {
    expect(formatMiles(t, 1609.344 * 12.6, "en-US")).toBe("13 mi");
    expect(formatMiles(t, 640, "en-US")).toBe("0.4 mi");
  });
});
