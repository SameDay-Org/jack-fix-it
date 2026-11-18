/**
 * Every colour the mascot draws. Parts name a tone (`"navy700"`), never a colour value: the
 * renderers look it up here, and a test fails on a colour that is not one of these.
 */

/** The brand tokens (docs/design/README.md, ADR 0008), as the web and the app use them. */
export const BRAND = {
  navy900: "#01172E",
  navy700: "#0B2D49",
  green500: "#5EB72B",
  green700: "#308127",
  white: "#FFFFFF",
  gray50: "#F7FBFC",
  gray500: "#484F57",
} as const;

/**
 * The few tones only the character needs, outside the interface's palette: a warm mid skin
 * tone with its shade and the cheeks' blush, dark hair, the inside of the open mouth, the
 * steel of the tools, and tan work boots (they stay visible on navy, where navy boots vanish).
 */
export const MASCOT_TONES = {
  skin: "#C68A63",
  skinShade: "#A9704C",
  blush: "#DC8670",
  hair: "#2A1E18",
  mouth: "#5A1C24",
  tongue: "#E06D6D",
  metal: "#BAC4CE",
  metalShade: "#8A97A5",
  boot: "#B07443",
  sole: "#3A2A20",
} as const;

export const PALETTE = { ...BRAND, ...MASCOT_TONES } as const;

export type Tone = keyof typeof PALETTE;
