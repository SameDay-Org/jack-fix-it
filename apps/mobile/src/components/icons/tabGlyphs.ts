import type { Glyph } from "./glyphs";

/**
 * The tab bar glyphs, in the category set's drawing system (`glyphs.ts`): a 24-unit view box,
 * strokes inside a 2-unit margin, one stroke width with round caps and joins, and one flat
 * green-500 accent that fills the object's main body. `TabIcon` paints the accent only on the
 * selected tab, so the active glyph reads as the filled one and the others as outlines.
 */
export const TAB_GLYPHS = {
  // A house: roof and walls, with an arched door.
  home: {
    accent: "M4.5 11L12 4.5L19.5 11V19.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z",
    strokes: [
      "M4.5 11L12 4.5L19.5 11V19.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z",
      "M10 20.5v-5a2 2 0 0 1 4 0v5",
    ],
  },
  // A receipt: a slip with a torn edge and three lines of print.
  history: {
    accent: "M6.5 3.5h11v17l-2.2-1.5-2.2 1.5-2.2-1.5-2.2 1.5-2.2-1.5Z",
    strokes: [
      "M6.5 3.5h11v17l-2.2-1.5-2.2 1.5-2.2-1.5-2.2 1.5-2.2-1.5Z",
      "M9.5 8.5h5",
      "M9.5 12h5",
      "M9.5 15.5h2.5",
    ],
  },
  // A person: head over shoulders.
  account: {
    accent: "M5 20.5c0-3.9 3.1-7 7-7s7 3.1 7 7Z",
    strokes: [
      "M12 4.5a3.25 3.25 0 1 0 0 6.5a3.25 3.25 0 1 0 0-6.5",
      "M5 20.5c0-3.9 3.1-7 7-7s7 3.1 7 7",
    ],
  },
} as const satisfies Record<string, Glyph>;

export type TabGlyphName = keyof typeof TAB_GLYPHS;
