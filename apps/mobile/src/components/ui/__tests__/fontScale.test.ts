import { tokens } from "@/theme";

import { scaledFontSize, type TextPlatform } from "../fontScale";
import { verifiedBadgeSize } from "../VerifiedBadge";

type TypeStyle = keyof typeof tokens.fontSize;

const ANDROID_15: TextPlatform = { os: "android", version: 35 };
const ANDROID_14: TextPlatform = { os: "android", version: 34 };
const ANDROID_13: TextPlatform = { os: "android", version: 33 };
const IOS: TextPlatform = { os: "ios", version: "18.2" };
const TYPES = Object.keys(tokens.fontSize) as TypeStyle[];
const SCALES = [1, 1.3, 2] as const;

/**
 * The size (dp) Android 14+ draws each type style at, worked out by hand from AOSP's tables
 * (FontScaleConverterFactory) and checked against the emulator's pixels (#262 evidence): not
 * computed by the code under test.
 */
const DRAWN_ON_ANDROID: Record<TypeStyle, Record<(typeof SCALES)[number], number>> = {
  display: { 1: 34, 1.3: 34, 2: 41.54 },
  "title-1": { 1: 28, 1.3: 28.8, 2: 37.33 },
  "title-2": { 1: 22, 1.3: 25, 2: 35 },
  headline: { 1: 17, 1.3: 20.9, 2: 29 },
  body: { 1: 16, 1.3: 20.2, 2: 28 },
  callout: { 1: 15, 1.3: 19.5, 2: 27 },
  footnote: { 1: 13, 1.3: 17.2, 2: 25 },
  caption: { 1: 12, 1.3: 15.6, 2: 24 },
};
const cases = TYPES.flatMap((type) => SCALES.map((scale) => [type, scale] as const));
/** How far the seal may be from the size the name is drawn at (#262). */
const TOLERANCE = 0.15;

describe("scaledFontSize", () => {
  it("covers every type style of the theme", () => {
    expect(Object.keys(DRAWN_ON_ANDROID).sort()).toEqual([...TYPES].sort());
  });

  it.each(cases)("Android 15 draws %s at font scale %s along its curve", (type, scale) => {
    const { size } = tokens.fontSize[type];
    expect(scaledFontSize(size, scale, ANDROID_15)).toBeCloseTo(DRAWN_ON_ANDROID[type][scale], 2);
    // The settings' steps are the same tables on Android 14.
    expect(scaledFontSize(size, scale, ANDROID_14)).toBeCloseTo(DRAWN_ON_ANDROID[type][scale], 2);
  });

  it.each(cases)("iOS and Android 13 multiply %s by font scale %s", (type, scale) => {
    const { size } = tokens.fontSize[type];
    expect(scaledFontSize(size, scale, IOS)).toBeCloseTo(size * scale, 5);
    expect(scaledFontSize(size, scale, ANDROID_13)).toBeCloseTo(size * scale, 5);
  });

  it("a font scale between two tables is blended from both", () => {
    // 17 sp is 20.9 dp at 1.3 and 23.5 dp at 1.5.
    expect(scaledFontSize(17, 1.4, ANDROID_15)).toBeCloseTo(22.2, 5);
    // 34 sp is 34 dp at 1.5 and 38.53 dp at 1.8.
    expect(scaledFontSize(34, 1.65, ANDROID_15)).toBeCloseTo(36.26, 2);
  });

  it("a font scale that reaches JS as a float still finds its own table", () => {
    // 1.15f as a double; its table puts 17 sp at 18.95 dp.
    expect(scaledFontSize(17, 1.149999976158142, ANDROID_15)).toBeCloseTo(18.95, 5);
    expect(scaledFontSize(17, 1.2999999523162842, ANDROID_15)).toBeCloseTo(20.9, 4);
  });

  it("multiplies outside the tables: below the first curve, above 2.0, and small text", () => {
    expect(scaledFontSize(17, 0.85, ANDROID_15)).toBeCloseTo(14.45, 5);
    expect(scaledFontSize(17, 1.04, ANDROID_15)).toBeCloseTo(17.68, 5);
    expect(scaledFontSize(17, 2.5, ANDROID_15)).toBeCloseTo(42.5, 5);
    // Under 8 sp a size keeps the first point's ratio; from 100 sp up, the last one's (1:1).
    expect(scaledFontSize(6, 1.3, ANDROID_15)).toBeCloseTo(7.8, 5);
    expect(scaledFontSize(120, 2, ANDROID_15)).toBeCloseTo(120, 5);
  });

  it("Android 14 has no curve under 1.15: it multiplies where Android 15 already bends", () => {
    expect(scaledFontSize(34, 1.1, ANDROID_14)).toBeCloseTo(37.4, 5);
    expect(scaledFontSize(34, 1.1, ANDROID_15)).toBeCloseTo(34, 5);
    expect(scaledFontSize(17, 1.1, ANDROID_15)).toBeCloseTo(18.3, 5);
    // 1.2 on Android 14 is blended from 1.15 and 1.3, and lands on Android 15's own 1.2 table.
    expect(scaledFontSize(17, 1.2, ANDROID_14)).toBeCloseTo(scaledFontSize(17, 1.2, ANDROID_15), 5);
  });

  it("reads the device it runs on when no platform is given", () => {
    // jest-expo runs as iOS.
    expect(scaledFontSize(34, 1.3)).toBeCloseTo(44.2, 5);
  });
});

describe("verifiedBadgeSize (#262)", () => {
  it.each(cases)(
    "on Android the %s seal at font scale %s stays within 15% of the size the name is drawn at",
    (type, scale) => {
      const drawn = DRAWN_ON_ANDROID[type][scale];
      for (const platform of [ANDROID_15, ANDROID_14]) {
        const seal = verifiedBadgeSize(type, scale, platform);
        expect(Number.isInteger(seal)).toBe(true);
        expect(seal).toBeLessThanOrEqual(drawn * (1 + TOLERANCE));
        expect(seal).toBeGreaterThanOrEqual(drawn * (1 - TOLERANCE));
        // In fact it is that size, to the whole dp.
        expect(Math.abs(seal - drawn)).toBeLessThanOrEqual(0.5);
      }
    },
  );

  it.each(TYPES)("at font scale 1.0 the %s seal is the type's own size, everywhere", (type) => {
    for (const platform of [ANDROID_15, ANDROID_14, ANDROID_13, IOS]) {
      expect(verifiedBadgeSize(type, 1, platform)).toBe(tokens.fontSize[type].size);
    }
  });

  it.each(cases)(
    "on iOS the %s seal at font scale %s is what it was: size times scale",
    (type, s) => {
      expect(verifiedBadgeSize(type, s, IOS)).toBe(Math.round(tokens.fontSize[type].size * s));
      expect(verifiedBadgeSize(type, s, ANDROID_13)).toBe(
        Math.round(tokens.fontSize[type].size * s),
      );
    },
  );

  it("a body-size seal on Android keeps its look: within a dp at 1.3, and no longer oversized at 2.0", () => {
    // Was 22 (17 x 1.3) beside letters drawn at 21 dp.
    expect(verifiedBadgeSize("headline", 1.3, ANDROID_15)).toBe(21);
    // Was 34 (17 x 2) beside letters drawn at 29 dp.
    expect(verifiedBadgeSize("headline", 2, ANDROID_15)).toBe(29);
  });

  it("a display seal no longer outgrows its name on Android", () => {
    // Was 44 and 68 beside letters drawn at 34 and 42 dp.
    expect(verifiedBadgeSize("display", 1.3, ANDROID_15)).toBe(34);
    expect(verifiedBadgeSize("display", 2, ANDROID_15)).toBe(42);
  });
});
