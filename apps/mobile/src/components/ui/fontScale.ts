import { Platform } from "react-native";

/** Where the text is drawn: the OS and, on Android, its API level (`Platform.Version`). */
export type TextPlatform = { os: typeof Platform.OS; version: number | string };

const devicePlatform = (): TextPlatform => ({ os: Platform.OS, version: Platform.Version });

/** Android 14: the first release that scales text along curves instead of multiplying. */
const CURVES_FROM_API = 34;
/** Android 15 added the 1.05 and 1.1 curves; Android 14 starts at 1.15 and multiplies below it. */
const SMALL_CURVES_FROM_API = 35;
const FIRST_CURVE_ANDROID_14 = 1.15;

/** The sizes (sp) every curve is defined at; between two of them a size is interpolated. */
const SIZES = [8, 10, 12, 14, 18, 20, 24, 30, 100] as const;
const LAST = SIZES.length - 1;

/**
 * Android's own tables: what each size in `SIZES` becomes (dp) at a font scale. Large text grows
 * less than small text, and from 30 sp up it stops growing until 1.8. Copied from AOSP
 * `android.content.res.FontScaleConverterFactory` (android15-release), the tables Jetpack Compose
 * also carries; a font scale between two rows is interpolated between them, as Android does.
 */
const CURVES: readonly (readonly [scale: number, sizes: readonly number[]])[] = [
  [1.05, [8.4, 10.5, 12.6, 14.8, 18.6, 20.6, 24.4, 30, 100]],
  [1.1, [8.8, 11, 13.2, 15.6, 19.2, 21.2, 24.8, 30, 100]],
  [1.15, [9.2, 11.5, 13.8, 16.4, 19.8, 21.8, 25.2, 30, 100]],
  [1.2, [9.6, 12, 14.4, 17.2, 20.4, 22.4, 25.6, 30, 100]],
  [1.3, [10.4, 13, 15.6, 18.8, 21.6, 23.6, 26.4, 30, 100]],
  [1.5, [12, 15, 18, 22, 24, 26, 28, 30, 100]],
  [1.8, [14.4, 18, 21.6, 24.4, 27.6, 30.8, 32.8, 34.8, 100]],
  [2, [16, 20, 24, 26, 30, 34, 36, 38, 100]],
];

const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
/** Font scales reach JS as floats (1.15 arrives as 1.149999976): compared in hundredths. */
const hundredths = (scale: number) => Math.round(scale * 100);

/** One curve at `fontScale`: the row itself, or the two rows around it blended. */
function curveAt(fontScale: number, curves: typeof CURVES): readonly number[] | null {
  const key = hundredths(fontScale);
  const above = curves.findIndex(([scale]) => hundredths(scale) >= key);
  // Past either end of the tables Android multiplies.
  if (above === -1) return null;
  const [upperScale, upper] = curves[above];
  if (hundredths(upperScale) === key) return upper;
  if (above === 0) return null;
  const [lowerScale, lower] = curves[above - 1];
  const t = (fontScale - lowerScale) / (upperScale - lowerScale);
  return lower.map((size, index) => lerp(size, upper[index], t));
}

/** A size on one curve: its own point, or between its two neighbours (from zero below the first). */
function onCurve(size: number, curve: readonly number[]): number {
  if (size >= SIZES[LAST]) return size * (curve[LAST] / SIZES[LAST]);
  const above = SIZES.findIndex((point) => point >= size);
  const [fromSize, from] = above === 0 ? [0, 0] : [SIZES[above - 1], curve[above - 1]];
  return lerp(from, curve[above], (size - fromSize) / (SIZES[above] - fromSize));
}

/**
 * The size (dp) a `size` sp text is drawn at for a font scale. iOS and Android up to 13 multiply.
 * Android 14 and later follow curves (see `CURVES`), so `size * fontScale` overstates large text: a
 * 34 sp title stays 34 dp at 1.3 and reaches 41.5 dp, not 68, at 2.0. Use it to size what must
 * match the text beside it (an inline icon); React Native reports only the raw font scale.
 */
export function scaledFontSize(
  size: number,
  fontScale: number,
  platform: TextPlatform = devicePlatform(),
): number {
  const api = platform.os === "android" ? Number(platform.version) : 0;
  if (api < CURVES_FROM_API) return size * fontScale;
  const curves =
    api >= SMALL_CURVES_FROM_API
      ? CURVES
      : CURVES.filter(([scale]) => scale >= FIRST_CURVE_ANDROID_14);
  const curve = curveAt(fontScale, curves);
  return curve ? onCurve(size, curve) : size * fontScale;
}
