import { describe, expect, it } from "vitest";

import {
  chooseHeroMode,
  hasFastWebGL2,
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
  webgl: true,
  cores: 8,
  memoryGb: 8,
  saveData: false,
  effectiveType: "4g",
  coarsePointer: false,
};

describe("the hero's mode (the fallback switch)", () => {
  it("is the 3D phone on a capable device", () => {
    expect(chooseHeroMode(CAPABLE)).toBe("webgl");
    // Safari reports neither memory nor connection: the frame-time probe decides there.
    expect(chooseHeroMode({ ...CAPABLE, memoryGb: null, cores: 4, effectiveType: null })).toBe(
      "webgl",
    );
  });

  it("is the still hero for reduced motion, whatever the device can do", () => {
    expect(chooseHeroMode({ ...CAPABLE, reducedMotion: true })).toBe("static");
    expect(chooseHeroMode({ ...CAPABLE, reducedMotion: true, webgl: false })).toBe("static");
  });

  it.each<[string, Partial<HeroEnv>]>([
    ["no WebGL 2 (or only a software one)", { webgl: false }],
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

/** A browser double: media queries by text, a canvas that gives a context or not. */
function browser(options: {
  queries?: Record<string, boolean>;
  context?: "fast" | "none" | "throws";
  navigator?: BrowserLike["navigator"];
}): BrowserLike & { asked: WebGLContextAttributes[]; lost: number } {
  const asked: WebGLContextAttributes[] = [];
  const double = {
    asked,
    lost: 0,
    navigator: options.navigator ?? {},
    matchMedia: (query: string) => ({ matches: options.queries?.[query] ?? false }),
    document: {
      createElement: () => ({
        getContext: (_: "webgl2", attributes: WebGLContextAttributes) => {
          asked.push(attributes);
          if (options.context === "throws") throw new Error("no canvas");
          if (options.context !== "fast") return null;
          return {
            getExtension: () => ({
              loseContext: () => {
                double.lost += 1;
              },
            }),
          };
        },
      }),
    },
  };
  return double;
}

describe("reading the browser", () => {
  it("asks for a WebGL 2 context that is not a slow software one, and releases it", () => {
    const fast = browser({ context: "fast" });
    expect(hasFastWebGL2(fast)).toBe(true);
    expect(fast.asked).toEqual([{ failIfMajorPerformanceCaveat: true }]);
    expect(fast.lost).toBe(1);
    expect(hasFastWebGL2(browser({ context: "none" }))).toBe(false);
    expect(hasFastWebGL2(browser({ context: "throws" }))).toBe(false);
  });

  it("reads memory, cores, connection and pointer where the browser gives them", () => {
    const env = readHeroEnv(
      browser({
        context: "fast",
        queries: { "(pointer: coarse)": true },
        navigator: {
          hardwareConcurrency: 6,
          deviceMemory: 2,
          connection: { saveData: true, effectiveType: "3g" },
        },
      }),
    );
    expect(env).toEqual({
      reducedMotion: false,
      webgl: true,
      cores: 6,
      memoryGb: 2,
      saveData: true,
      effectiveType: "3g",
      coarsePointer: true,
    });
  });

  it("leaves out what the browser does not say, and makes no context for reduced motion", () => {
    const still = browser({
      context: "fast",
      queries: { "(prefers-reduced-motion: reduce)": true },
    });
    expect(readHeroEnv(still)).toMatchObject({
      reducedMotion: true,
      webgl: false,
      cores: null,
      memoryGb: null,
      saveData: false,
      effectiveType: null,
    });
    expect(still.asked).toEqual([]);
  });
});
