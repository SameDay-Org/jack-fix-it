import { describe, expect, it } from "vitest";

import {
  chooseHeroMode,
  isLowEnd,
  MAX_PIXEL_RATIO,
  maxPixelRatio,
  readHeroEnv,
  type BrowserLike,
  type HeroEnv,
} from "./capabilities";

/** A capable desktop browser; each test changes what it is about. */
const CAPABLE: HeroEnv = {
  reducedMotion: false,
  cores: 8,
  memoryGb: 8,
  saveData: false,
  effectiveType: "4g",
  coarsePointer: false,
};

describe("the hero's mode (the fallback switch)", () => {
  it("is the 3D phone (built on intent) on a capable device", () => {
    expect(chooseHeroMode(CAPABLE)).toBe("webgl");
    // Safari reports neither memory nor connection: the frame-time probe decides there.
    expect(chooseHeroMode({ ...CAPABLE, memoryGb: null, cores: 4, effectiveType: null })).toBe(
      "webgl",
    );
  });

  it("is the still hero for reduced motion, whatever the device can do", () => {
    expect(chooseHeroMode({ ...CAPABLE, reducedMotion: true })).toBe("static");
    expect(chooseHeroMode({ ...CAPABLE, reducedMotion: true, memoryGb: 2 })).toBe("static");
  });

  it.each<[string, Partial<HeroEnv>]>([
    ["less than 4 GB of memory", { memoryGb: 2 }],
    ["less than 4 cores", { cores: 2 }],
    ["data saving", { saveData: true }],
    ["a 3G connection", { effectiveType: "3g" }],
    ["a 2G connection", { effectiveType: "2g" }],
    ["a slow 2G connection", { effectiveType: "slow-2g" }],
  ])("is the CSS phone with %s", (_, change) => {
    expect(chooseHeroMode({ ...CAPABLE, ...change })).toBe("css");
  });

  it("reads low-end only from what Chromium reports", () => {
    expect(isLowEnd({ cores: 2, memoryGb: null })).toBe(false);
    expect(isLowEnd({ cores: null, memoryGb: 2 })).toBe(true);
    expect(isLowEnd({ cores: 4, memoryGb: 4 })).toBe(false);
  });

  it("caps the canvas's pixel ratio at 1.5 on touch devices, 2 elsewhere", () => {
    expect(MAX_PIXEL_RATIO.coarse).toBe(1.5);
    expect(maxPixelRatio({ coarsePointer: true })).toBe(1.5);
    expect(maxPixelRatio({ coarsePointer: false })).toBe(2);
  });
});

/** A browser double: media queries answered by their text. */
function browser(
  queries: Record<string, boolean>,
  navigator: BrowserLike["navigator"] = {},
): BrowserLike & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    navigator,
    matchMedia: (query: string) => {
      asked.push(query);
      return { matches: queries[query] ?? false };
    },
  };
}

describe("reading the browser", () => {
  it("reads memory, cores, connection and pointer where the browser gives them", () => {
    const env = readHeroEnv(
      browser(
        { "(pointer: coarse)": true },
        {
          hardwareConcurrency: 6,
          deviceMemory: 2,
          connection: { saveData: true, effectiveType: "3g" },
        },
      ),
    );
    expect(env).toEqual({
      reducedMotion: false,
      cores: 6,
      memoryGb: 2,
      saveData: true,
      effectiveType: "3g",
      coarsePointer: true,
    });
  });

  it("leaves out what the browser does not say", () => {
    expect(readHeroEnv(browser({ "(prefers-reduced-motion: reduce)": true }))).toEqual({
      reducedMotion: true,
      cores: null,
      memoryGb: null,
      saveData: false,
      effectiveType: null,
      coarsePointer: false,
    });
  });

  it("needs nothing but media queries and the navigator: no WebGL context is made to choose", () => {
    const fake = browser({});
    readHeroEnv(fake);
    // BrowserLike has no document: making a canvas or a context here would not compile.
    expect(Object.keys(fake).sort()).toEqual(["asked", "matchMedia", "navigator"]);
    expect(fake.asked).toEqual(["(prefers-reduced-motion: reduce)", "(pointer: coarse)"]);
  });
});
