import { tokens } from "@/theme";

export type IdCardVariant = "customer" | "pro";
export type IdCardFace = "front" | "back";

/** The card is designed at this width in dp; every dimension scales by `width / ID_CARD_BASE_WIDTH`. */
export const ID_CARD_BASE_WIDTH = 320;

/** ID-1 (85.6 x 54 mm): the proportions of a real card. The shareable render keeps them exactly. */
export const ID_CARD_ASPECT = 85.6 / 54;

/**
 * The card's dimensions at the design width, in dp. Multiplied by the geometry's `unit` they hold
 * their proportions at any width, on screen (288 dp on a 320 dp phone) or off screen at 3x for
 * the share image.
 */
export const ID_CARD_BASE = {
  padding: 16,
  radius: tokens.radius.md,
  /** From the "Hello, I'm:" line down to the photo row. */
  headerGap: 8,
  /** From the photo to the name column. */
  columnGap: 14,
  /** A 4:5 portrait, the proportions of a passport photo. */
  photo: { width: 92, height: 115, radius: tokens.radius.sm },
  proBadge: { gap: 6, paddingX: 8, paddingY: 2 },
  /** The back's magnetic stripe. */
  stripe: { top: 20, height: 26 },
  /** The 3D camera distance, close enough that a lean reads as depth on a phone-wide card. */
  perspective: 700,
} as const;

export type IdCardGeometry = {
  width: number;
  /** The ID-1 height for this width, whole dp: the shareable height, the on-screen minimum. */
  height: number;
  /** The scale from the design width. */
  unit: number;
};

export function idCardGeometry(width: number): IdCardGeometry {
  return {
    width,
    height: Math.round(width / ID_CARD_ASPECT),
    unit: width / ID_CARD_BASE_WIDTH,
  };
}

/** Characters per group on the back: `K7Q2-9MXA`. */
export const PUBLIC_CODE_GROUP = 4;

/**
 * The public code as the back engraves it: uppercase, in groups of four joined by a hyphen. Any
 * separator the input carries is dropped first, so a code that arrives grouped stays grouped once.
 */
export function formatPublicCode(code: string): string {
  const characters = code.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  const groups = characters.match(new RegExp(`.{1,${PUBLIC_CODE_GROUP}}`, "g"));
  return groups?.join("-") ?? "";
}

/** "Fort Lauderdale, FL": the parts that are set, trimmed, never the street. */
export function placeOf(city?: string, state?: string): string {
  return [city, state]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(", ");
}
