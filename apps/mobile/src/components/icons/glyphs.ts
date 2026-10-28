/**
 * The category glyphs, keyed by category slug (`apps/api/app/modules/categories/seed_data.json`):
 * the slug is stable while the names are admin-editable, and the seed's `icon` field is empty.
 *
 * One drawing system for the whole set (docs/design "Iconography"): a 24-unit view box, strokes
 * kept inside a 2-unit margin, one stroke width with round caps and joins in one color, and one flat
 * green-500 accent per glyph, drawn under the strokes. The accent always fills the object's one main
 * body inside its own outline: the bottle, the hammer head, the roller sleeve, the leaves, the box.
 * Only path data lives here, so the style cannot drift per glyph: `CategoryIcon` paints them all.
 */
export type Glyph = {
  /** One fill path (it may hold several subpaths), drawn first; decoration, never the meaning. */
  accent: string | null;
  /** Stroke paths: navy (or the icon's color), no fill. */
  strokes: readonly string[];
};

export const GLYPH_VIEW_BOX = 24;
export const GLYPH_STROKE_WIDTH = 1.75;

export const CATEGORY_GLYPHS = {
  // A spray bottle with mist.
  "house-cleaning": {
    accent: "M5 21v-6.5L7 11h4l2 3.5V21Z",
    strokes: [
      "M5 21v-6.5L7 11h4l2 3.5V21Z",
      "M7 11V5.5h7l2 3h-5V11M14.5 8.5l-.5 2.5",
      "M18.5 4.5l2-1.25",
      "M18.5 7h2.5",
      "M18.5 9.5l2 1.25",
    ],
  },
  // A claw hammer.
  handyman: {
    accent:
      "M18 15.5L20.5 13Q21 12.5 20.5 12L14 5.5Q10.5 2 6 5.5Q10 6.5 11.5 10L17 15.5Q17.5 16 18 15.5Z",
    strokes: [
      "M18 15.5L20.5 13Q21 12.5 20.5 12L14 5.5Q10.5 2 6 5.5Q10 6.5 11.5 10L17 15.5Q17.5 16 18 15.5Z",
      "M11.5 10L3.5 18Q2.5 19 3.5 20Q4.5 21 5.5 20L13.5 12",
    ],
  },
  // A paint roller.
  painting: {
    accent: "M6 3h10a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
    strokes: [
      "M6 3h10a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
      "M18 6h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 0-1.5 1.5V15",
      "M11 15h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z",
    ],
  },
  // A sprout over a ground line with a grass tuft.
  "lawn-landscaping": {
    accent:
      "M12 12c0-5 3-8.5 8-8.5c0 5-3 8.5-8 8.5ZM12 15.5c0-3.5-2.5-6.5-7-6.5c0 3.5 2.5 6.5 7 6.5Z",
    strokes: [
      "M12 21v-9",
      "M12 12c0-5 3-8.5 8-8.5c0 5-3 8.5-8 8.5Z",
      "M12 15.5c0-3.5-2.5-6.5-7-6.5c0 3.5 2.5 6.5 7 6.5Z",
      "M3.5 21h17M16 21l-.75-3M18.5 21l.75-3",
    ],
  },
  // A hand truck carrying a taped box.
  "moving-assembly": {
    accent: "M9 16.5V5.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v11Z",
    strokes: [
      "M3 3.5h1a1.5 1.5 0 0 1 1.5 1.5v11.5h15.5",
      "M9 16.5V5.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v11",
      "M14.5 4.5v3.5",
      "M5.5 16.5a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 1 0 0-4.5",
    ],
  },
} as const satisfies Record<string, Glyph>;

export type CategorySlug = keyof typeof CATEGORY_GLYPHS;

/** The glyph for a slug; `undefined` for a slug without one (a category added later by an admin). */
export function glyphFor(slug: string): Glyph | undefined {
  // Own keys only: "constructor" or "toString" must not reach Object.prototype.
  return Object.hasOwn(CATEGORY_GLYPHS, slug) ? CATEGORY_GLYPHS[slug as CategorySlug] : undefined;
}
