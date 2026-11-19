import { tokens } from "@/theme";

export type IdCardVariant = "customer" | "pro";
export type IdCardFace = "front" | "back";

/** The card is designed at this width in dp; every dimension scales by `width / ID_CARD_BASE_WIDTH`. */
export const ID_CARD_BASE_WIDTH = 320;

/** ID-1 (85.6 x 54 mm): the proportions of a real card. The shareable render keeps them exactly. */
export const ID_CARD_ASPECT = 85.6 / 54;

/**
 * The card's dimensions at the design width (320 x 202 dp), on a 4 dp grid where the type allows.
 * Multiplied by the geometry's `unit` they hold their proportions at any width, on screen (288 dp
 * on a 320 dp phone) or off screen at 3x for the share image.
 *
 *   0 ┌───────────────────────────────────────┐  header band: "Hello, I'm:" (28)
 *  36 │ ┌──────┐  Name, two lines at most      │  photo plate 88 x 110, name column in flow
 *     │ │ photo│  City, ST                     │
 *     │ │      │  phone                        │
 * 146 │ └─PRO──┘                               │  PRO straddles the plate's bottom edge
 * 160 │ ·JACK FIX IT·JACK FIX IT·JACK FIX IT·  │  microtext rule
 * 166 │ MEMBER SINCE              ▬ Jack Fix It│  footer (26)
 * 202 └───────────────────────────────────────┘
 */
export const ID_CARD_BASE = {
  /** ID-1 corners: 3.18 of 85.6 mm, 12 dp at the design width. */
  radius: tokens.radius.sm,
  paddingX: 16,
  header: { height: 28, ruleGap: 8 },
  bodyTop: 36,
  /** From the photo plate to the name column. */
  columnGap: 14,
  /** A 4:5 portrait plate: a ring, a mat in the card's own color, then the photo. */
  photo: { width: 88, height: 110, radius: 10, ring: 1.5, mat: 2 },
  /** PRO's pill: its height, and its width as a fraction of the photo plate's. */
  proBadge: { height: 16, width: 0.5 },
  /** The microtext rule's top, and the footer row's height and bottom margin. */
  rule: { top: 160 },
  footer: { height: 26, bottom: 10 },
  /** The back: the magnetic-stripe band, and the code panel under it. */
  stripe: { top: 16, height: 30 },
  code: { top: 58, barsHeight: 18, barsWidth: 156 },
  /** The plastic's thickness: an ID-1 card is 0.76 mm; drawn a little thicker so it reads. */
  thickness: 3,
  /** The 3D camera distance, close enough that a lean reads as depth on a phone-wide card. */
  perspective: 700,
} as const;

export type IdCardGeometry = {
  width: number;
  /** The ID-1 height for this width, whole dp: the card is always exactly this tall. */
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

/** The card's height at the design width, the view box height of its print. */
export const ID_CARD_BASE_HEIGHT = idCardGeometry(ID_CARD_BASE_WIDTH).height;

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

// The security print: computed once, in design units, and scaled by each SVG's view box.

/** The guilloche field: two families of interlaced waves drifting against each other. */
const WAVES = {
  perFamily: 9,
  /** Two sine terms per wave: a long swell and a short ripple. */
  swell: { amplitude: 7, period: 112 },
  ripple: { amplitude: 2.5, period: 46 },
  /** How far each wave's phase moves from the one above it, in radians. */
  phaseStep: 0.6,
  /** A point every this many design units: chords this short stay within 0.1 of the curve. */
  step: 8,
  /** The field runs past the card's edges, so no wave ends inside it. */
  bleed: 12,
} as const;

const round1 = (value: number) => Math.round(value * 10) / 10;

/** One SVG path of every guilloche wave across a card of this design size. */
export function guillochePath(
  width: number = ID_CARD_BASE_WIDTH,
  height: number = ID_CARD_BASE_HEIGHT,
): string {
  const { perFamily, swell, ripple, phaseStep, step, bleed } = WAVES;
  const tau = Math.PI * 2;
  const spacing = (height + bleed * 2) / perFamily;
  const parts: string[] = [];
  for (const family of [1, -1]) {
    for (let line = 0; line < perFamily; line += 1) {
      const baseline = -bleed + spacing * (line + (family === 1 ? 0.25 : 0.75));
      const phase = family * line * phaseStep + (family === 1 ? 0 : Math.PI);
      const points: string[] = [];
      for (let x = -bleed; x <= width + bleed; x += step) {
        const y =
          baseline +
          swell.amplitude * Math.sin((tau * x) / swell.period + phase) +
          ripple.amplitude * Math.sin((tau * x) / ripple.period + phase * 2);
        points.push(`${round1(x)} ${round1(y)}`);
      }
      parts.push(`M${points.join("L")}`);
    }
  }
  return parts.join("");
}

/** The rosette: scalloped rings laid one inside the next, each a little turned, so they interlace. */
const ROSETTE = {
  rings: 7,
  /** The innermost ring's radius, as a fraction of the outer one: the center stays open. */
  inner: 0.42,
  scallops: 20,
  /** Each scallop's depth, as a fraction of the outer radius. */
  depth: 0.09,
  /** Points per scallop: enough that 0.5-unit strokes stay round at 3x. */
  resolution: 8,
} as const;

/**
 * One SVG path of a guilloche rosette centered at (cx, cy) with this outer radius: `ROSETTE.rings`
 * scalloped rings, each turned half a scallop from the last, deep enough to cross its neighbours.
 */
export function rosettePath(cx: number, cy: number, radius: number): string {
  const { rings, inner, scallops, depth, resolution } = ROSETTE;
  const steps = scallops * resolution;
  const parts: string[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const base = radius * (inner + ((1 - inner - depth) * ring) / (rings - 1));
    const turn = (ring * Math.PI) / scallops;
    const points: string[] = [];
    for (let i = 0; i < steps; i += 1) {
      const t = (Math.PI * 2 * i) / steps;
      const r = base + radius * depth * Math.sin(scallops * t + turn * scallops);
      points.push(`${round1(cx + r * Math.cos(t))} ${round1(cy + r * Math.sin(t))}`);
    }
    parts.push(`M${points.join("L")}Z`);
  }
  return parts.join("");
}

export type DecorativeBar = { x: number; width: number };

/** Bar and gap widths, in design units, that the code picks from: a barcode's rhythm. */
const BAR_WIDTHS = [1, 1, 1.5, 2.5] as const;
const GAP_WIDTHS = [1, 1.5, 2] as const;

/**
 * A strip of bars that looks like a barcode and encodes nothing: each code draws its own rhythm
 * (FNV-1a of the code seeds it), so two cards differ, but no scanner can read it and the card
 * never claims one could. The bars fill `width` design units from 0.
 */
export function decorativeBars(code: string, width: number): DecorativeBar[] {
  let seed = 0x811c9dc5;
  for (const character of code) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  const next = () => {
    // xorshift32: the same code always draws the same strip.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed;
  };
  const bars: DecorativeBar[] = [];
  let x = 0;
  for (;;) {
    const bar = BAR_WIDTHS[next() % BAR_WIDTHS.length];
    if (x + bar > width) return bars;
    bars.push({ x, width: bar });
    x += bar + GAP_WIDTHS[next() % GAP_WIDTHS.length];
  }
}

// Motion geometry: worklets, run on the UI thread on every frame the card moves.

/** The most the card leans, drag and gyroscope together, in degrees. */
export const MAX_TILT = 22;
const RADIANS = Math.PI / 180;

/** `value` held within ±`limit` degrees (±`MAX_TILT` when no limit is given). */
export function clampTilt(value: number, limit?: number): number {
  "worklet";
  // In the body, not a default parameter: the worklet captures what its body reads.
  const cap = limit ?? MAX_TILT;
  return Math.min(cap, Math.max(-cap, value));
}

/**
 * Where a part that floats `depth` dp above the card's face (below it when negative) appears to
 * sit on the face as the card leans `tiltX` / `tiltY` degrees around X / Y: in a turn that sends
 * the right edge back, a raised part slides right and a sunken one left.
 */
export function parallaxOffset(
  tiltX: number,
  tiltY: number,
  depth: number,
): { x: number; y: number } {
  "worklet";
  return { x: depth * Math.tan(tiltY * RADIANS), y: -depth * Math.tan(tiltX * RADIANS) };
}

/** How much the card grows at the middle of a flip, on top of its lift. */
const FLIP_LIFT = 0.05;

/** The card's scale: its lift (1 at rest, 1.03 under a finger) and a little more mid-flip. */
export function cardScale(lift: number, turn: number): number {
  "worklet";
  return lift + Math.sin(Math.abs(turn) * RADIANS) * FLIP_LIFT;
}

/** The ground shadow, in design dp (scaled by `unit` on screen). */
const SHADOW = {
  /** Its drop under the card at rest, and how far it slides at the full lean. */
  drop: 5,
  drift: 14,
  /** Per unit of lift above rest (scale 1.03 held, up to 1.08 mid-flip): sinks, spreads, fades. */
  liftDrop: 160,
  liftSpread: 2.2,
  liftFade: 5,
  /** Edge-on mid-flip the shadow narrows to this fraction of the card's width, never less. */
  edgeOn: 0.12,
} as const;

export type GroundShadow = {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
};

/**
 * The shadow the card casts on the page: it moves against the lean (the light is above the
 * phone), foreshortens with the card, sinks, widens and softens as the card lifts, and narrows as
 * the card turns edge-on.
 * `lift` is the card's scale (`cardScale`: 1 at rest, up to 1.08 mid-flip), `turn` its flip angle
 * in degrees, `unit` its design scale.
 */
export function groundShadow(
  tiltX: number,
  tiltY: number,
  lift: number,
  turn: number,
  unit: number,
): GroundShadow {
  "worklet";
  const raised = Math.max(0, lift - 1);
  const spread = 1 + raised * SHADOW.liftSpread;
  return {
    translateX: -(tiltY / MAX_TILT) * SHADOW.drift * unit,
    translateY: (SHADOW.drop + (tiltX / MAX_TILT) * SHADOW.drift + raised * SHADOW.liftDrop) * unit,
    scaleX:
      spread *
      Math.max(SHADOW.edgeOn, Math.abs(Math.cos(turn * RADIANS))) *
      Math.cos(tiltY * RADIANS),
    scaleY: spread * Math.cos(tiltX * RADIANS),
    opacity: Math.max(0, 1 - raised * SHADOW.liftFade),
  };
}

/** The specular band: how far it slides at the full lean (a fraction of the card) and its glow. */
const SHEEN = { travel: 0.24, rest: 0.55 } as const;

/** The sheen's strength on a card at rest: the share render and Reduce Motion hold it here. */
export const SHEEN_REST = SHEEN.rest;

export type SheenPose = { translateX: number; translateY: number; strength: number };

/**
 * Where the band of light sits on a card `width` x `height` leaning `tiltX` / `tiltY`, and how
 * bright it is (0..1): it slides across as the card leans and brightens with the lean.
 */
export function sheenPose(tiltX: number, tiltY: number, width: number, height: number): SheenPose {
  "worklet";
  const lean = Math.min(1, (Math.abs(tiltX) + Math.abs(tiltY)) / MAX_TILT);
  return {
    translateX: (tiltY / MAX_TILT) * width * SHEEN.travel,
    translateY: (-tiltX / MAX_TILT) * height * SHEEN.travel,
    strength: SHEEN.rest + (1 - SHEEN.rest) * lean,
  };
}
