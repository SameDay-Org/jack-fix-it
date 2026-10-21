import { VARIANT } from "@/components/ui/Button";
import { TONE } from "@/components/ui/StatusBadge";

import tokens from "./tokens.json";

type ColorToken = keyof typeof tokens.colors;
type Rgb = [number, number, number];

const COLOR_TOKENS = Object.keys(tokens.colors) as ColorToken[];

// WCAG 2.x: text needs 4.5:1, non-text (icons, status dots) 3:1.
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

// The badges and buttons sit on bubbles (white) or on the app background (gray-50).
const LIGHT_SURFACES: ColorToken[] = ["white", "gray-50"];

function rgbOf(token: ColorToken): Rgb {
  const hex = tokens.colors[token];
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return [channel(1), channel(3), channel(5)];
}

// Relative luminance and contrast ratio as defined by WCAG 2.x.
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The 8-bit color the screen shows for `fg` at `alpha` over `bg`. */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])];
}

type Paint = { token: ColorToken; alpha: number };

/** The color token and `/opacity` of the one `bg-` or `text-` class in a class list, if any. */
function paintOf(classes: string, prefix: "bg" | "text"): Paint | undefined {
  const pattern = new RegExp("^" + prefix + "-(" + COLOR_TOKENS.join("|") + ")(?:/([0-9]{1,3}))?$");
  for (const className of classes.split(/\s+/)) {
    const match = pattern.exec(className);
    if (match) {
      return { token: match[1] as ColorToken, alpha: match[2] ? Number(match[2]) / 100 : 1 };
    }
  }
  return undefined;
}

/** Contrast of a text paint over a fill paint on a surface; a missing fill is the surface itself. */
function paintedContrast(text: Paint, fill: Paint | undefined, surface: ColorToken): number {
  const background = fill
    ? composite(rgbOf(fill.token), fill.alpha, rgbOf(surface))
    : rgbOf(surface);
  return contrast(rgbOf(text.token), background);
}

// The "Pass" rows of the contrast table in docs/design/README.md.
const PASS_PAIRS: [ColorToken, ColorToken, string][] = [
  ["white", "navy-900", "hero headline and body on navy"],
  ["white", "navy-700", "text on dark secondary surfaces"],
  ["green-500", "navy-900", "accent headline words on navy"],
  ["green-500", "navy-700", "accent text on dark secondary surfaces"],
  ["navy-900", "green-500", "primary CTA label"],
  ["white", "green-700", "pressed CTA label"],
  ["navy-900", "white", "body text on bubbles"],
  ["navy-900", "gray-50", "body text on the app background"],
  ["gray-500", "white", "muted text on bubbles"],
  ["gray-500", "gray-50", "muted text on the app background"],
  ["green-700", "white", "green text and links on bubbles"],
  ["green-700", "gray-50", "green text on the app background"],
  ["danger", "white", "error text on bubbles"],
  ["danger", "gray-50", "error text on the app background"],
  ["white", "danger", "destructive button label"],
  ["navy-900", "warning", "warning badge text"],
];

// The "Forbidden" rows of the same table.
const FORBIDDEN_PAIRS: [ColorToken, ColorToken][] = [
  ["white", "green-500"],
  ["green-500", "white"],
  ["navy-900", "green-700"],
  ["gray-500", "navy-700"],
];

describe("theme tokens", () => {
  it("token names match the brief", () => {
    expect(COLOR_TOKENS).toEqual([
      "navy-900",
      "navy-700",
      "green-500",
      "green-700",
      "white",
      "gray-50",
      "gray-500",
      "danger",
      "success",
      "warning",
    ]);
    expect(tokens.radius).toEqual({ sm: 12, md: 16, lg: 24, xl: 32, pill: 9999 });
    expect(Object.keys(tokens.fontSize)).toEqual([
      "display",
      "title-1",
      "title-2",
      "headline",
      "body",
      "callout",
      "footnote",
      "caption",
    ]);
    for (const style of Object.values(tokens.fontSize)) {
      expect(style).toEqual({
        size: expect.any(Number),
        lineHeight: expect.any(Number),
        fontWeight: expect.any(Number),
      });
    }
  });

  it.each(PASS_PAIRS)('every "Pass" pair in the brief meets AA: %s on %s (%s)', (fg, bg) => {
    expect(contrast(rgbOf(fg), rgbOf(bg))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("the success icon meets the non-text bar on white", () => {
    expect(contrast(rgbOf("success"), rgbOf("white"))).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it.each(FORBIDDEN_PAIRS)('every "Forbidden" pair fails AA: %s on %s', (fg, bg) => {
    expect(contrast(rgbOf(fg), rgbOf(bg))).toBeLessThan(AA_TEXT);
  });

  it.each(Object.entries(TONE))(
    "badge tint backgrounds keep their text at AA: %s",
    (_tone, { container, text }) => {
      const fill = paintOf(container, "bg");
      const label = paintOf(text, "text");
      expect(fill).toBeDefined();
      expect(label).toBeDefined();
      for (const surface of LIGHT_SURFACES) {
        expect(paintedContrast(label!, fill, surface)).toBeGreaterThanOrEqual(AA_TEXT);
      }
    },
  );

  it.each(Object.entries(VARIANT))(
    "button labels keep AA at rest and pressed: %s",
    (_variant, { fill, label }) => {
      for (const state of ["rest", "pressed"] as const) {
        const text = paintOf(label[state], "text");
        expect(text).toBeDefined();
        for (const surface of LIGHT_SURFACES) {
          expect(
            paintedContrast(text!, paintOf(fill[state], "bg"), surface),
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    },
  );
});
