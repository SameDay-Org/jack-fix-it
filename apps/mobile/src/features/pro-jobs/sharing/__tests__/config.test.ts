import { DEFAULT_SHARING_SECONDS, readSharingConfig } from "../config";

const read = (sharing?: string, seconds?: string) => readSharingConfig({ sharing, seconds });
const SECONDS_ERROR = /EXPO_PUBLIC_PRO_LOCATION_SECONDS must be a positive whole number/;

describe("readSharingConfig", () => {
  it("is off, every 10 s, when nothing is set", () => {
    expect(read()).toEqual({ enabled: false, intervalMs: 10_000 });
    expect(DEFAULT_SHARING_SECONDS).toBe(10);
  });

  it("is on only for exactly 'on'", () => {
    expect(read("on").enabled).toBe(true);
  });

  it.each(["", "ON", "On", " on", "on ", "true", "1", "yes", "off"])(
    "stays off for %j",
    (value) => {
      expect(read(value).enabled).toBe(false);
    },
  );

  it("reads the interval in whole seconds", () => {
    expect(read("on", "15").intervalMs).toBe(15_000);
    expect(read("on", " ").intervalMs).toBe(10_000);
  });

  it.each(["0", "-5", "2.5", "ten", "1e"])("refuses the interval %j", (value) => {
    expect(() => read("on", value)).toThrow(SECONDS_ERROR);
  });
});
