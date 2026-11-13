import type { Glyph } from "./glyphs";

/**
 * The Account menu's glyphs (#293), in the category set's drawing system (`glyphs.ts`): a 24-unit
 * view box, strokes inside a 2-unit margin, one stroke width with round caps and joins, and one flat
 * green-500 accent filling the object's main body. `CategoryIcon` paints them (pass `glyph`).
 */
export const ACCOUNT_GLYPHS = {
  // Three sliders, each knob set at its own level.
  settings: {
    accent:
      "M9 4.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 1 0 0-4.5M15 9.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 1 0 0-4.5M8 14.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 1 0 0-4.5",
    strokes: [
      "M4 7h2.75",
      "M11.25 7H20",
      "M4 12h8.75",
      "M17.25 12H20",
      "M4 17h1.75",
      "M10.25 17H20",
      "M9 4.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 1 0 0-4.5",
      "M15 9.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 1 0 0-4.5",
      "M8 14.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 1 0 0-4.5",
    ],
  },
  // A map pin with its round hole: a saved address.
  addresses: {
    accent: "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z",
    strokes: [
      "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z",
      "M12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5",
    ],
  },
  // A round speech bubble asking a question.
  help: {
    accent: "M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5Z",
    strokes: [
      "M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5Z",
      "M9.75 9.75a2.25 2.25 0 1 1 3.4 1.95c-.7.4-1.15.9-1.15 1.7v.35",
      "M12 16.5v.01",
    ],
  },
  // A page with a folded corner and its lines of text.
  legal: {
    accent: "M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z",
    strokes: [
      "M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z",
      "M14 3.5v4h4",
      "M9 11.5h6",
      "M9 14.5h6",
      "M9 17.5h3.5",
    ],
  },
  // An open door with an arrow leaving through it.
  logOut: {
    accent: "M5.5 5a1 1 0 0 1 1-1h6.5v16H6.5a1 1 0 0 1-1-1Z",
    strokes: [
      "M13 4H6.5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1H13",
      "M10.5 12h10",
      "M17 8.5l3.5 3.5-3.5 3.5",
    ],
  },
} as const satisfies Record<string, Glyph>;

export type AccountGlyphName = keyof typeof ACCOUNT_GLYPHS;
