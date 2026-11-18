// Class strings the showcase sections share. Colors and radii are the brand tokens of
// globals.css; nothing here adds one.

/** The page's column: the same width and gutters in every section. */
export const CONTAINER = "mx-auto w-full max-w-6xl px-5 sm:px-8";

/** Keyboard focus on a light surface, and on navy (the ring must show on both). */
export const FOCUS_ON_LIGHT =
  "outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2";
export const FOCUS_ON_NAVY =
  "outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-navy-900";

/** The lime pill: navy text on green-500, white on green-700 when hovered (never white on lime). */
export const PRIMARY_ACTION =
  "inline-flex h-12 items-center justify-center gap-2 rounded-pill bg-green-500 px-7 text-base font-bold text-navy-900 transition-colors hover:bg-green-700 hover:text-white";

/** The small label above a headline. */
export const EYEBROW = "text-sm font-bold tracking-widest uppercase";

/** A section's headline. */
export const SECTION_TITLE =
  "text-[clamp(2rem,3.5vw+1rem,3.25rem)] leading-[1.08] font-extrabold tracking-tight text-balance [word-spacing:0.1em]";
