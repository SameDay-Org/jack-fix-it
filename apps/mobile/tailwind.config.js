const { colors, radius, fontSize } = require("./src/theme/tokens.json");

const px = (value) => `${value}px`;

// The scales below replace Tailwind's defaults instead of extending them, so the only classes that
// exist are token classes: bg-navy-900, rounded-lg, text-headline. Spacing keeps Tailwind's scale,
// which is the 4-pt grid because metro.config.js sets the rem to 16 (p-4 = 16, min-h-12 = 48).
// Shadows are not classes: the one recipe is `bubbleShadow` in src/theme (see the note there).
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    // `transparent` is a keyword, not a color: it keeps a ring's width constant while it is invisible.
    colors: { ...colors, transparent: "transparent" },
    borderRadius: Object.fromEntries(
      Object.entries(radius).map(([name, value]) => [name, px(value)]),
    ),
    fontSize: Object.fromEntries(
      Object.entries(fontSize).map(([name, style]) => [
        name,
        [
          px(style.size),
          { lineHeight: px(style.lineHeight), fontWeight: String(style.fontWeight) },
        ],
      ]),
    ),
    boxShadow: {},
  },
};
