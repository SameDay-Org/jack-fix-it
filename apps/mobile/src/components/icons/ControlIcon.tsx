import Svg, { Path } from "react-native-svg";

import { GLYPH_STROKE_WIDTH, GLYPH_VIEW_BOX } from "./glyphs";

// Small control glyphs on the icon grid (24 units, round caps), stroke only.
const CONTROL_GLYPHS = {
  plus: ["M12 6v12", "M6 12h12"],
  minus: ["M6 12h12"],
  // A cross, for closing a full-screen view.
  close: ["M7 7l10 10", "M17 7L7 17"],
  // A picture frame with hills, where a photo cannot be shown.
  photo: [
    "M6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-9A2.5 2.5 0 0 1 6.5 5Z",
    "M5 17l4.5-4.5 3 3 2.5-2.5L19 17",
  ],
  // A play triangle, for a video's thumbnail.
  play: ["M9 6.5v11l8.5-5.5Z"],
  // A check mark, for a request that went through.
  check: ["M5.5 12.5l4.5 4.5 8.5-10"],
  // A chevron pointing on, for a row that opens its screen.
  chevron: ["M9.5 6l6 6-6 6"],
  // The same chevron pointing back, for a screen's way back over a hero.
  back: ["M14.5 6l-6 6 6 6"],
  // A box with an arrow rising out of it, for sharing.
  share: ["M12 14.5V4", "M8 8l4-4 4 4", "M6 11.5v7.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7.5"],
  // An arrow rising, for sending a message.
  send: ["M12 19V5.5", "M6 11.5l6-6 6 6"],
  // A five-point star, for a rating: outlined while empty, drawn filled once given.
  star: [
    "M12 3.32L14.54 9.42L21.13 9.95L16.11 14.25L17.64 20.68L12 17.24L6.36 20.68L7.89 14.25L2.87 9.95L9.46 9.42Z",
  ],
  // Three dots in a row, for a menu of more actions (draw it filled).
  more: [
    "M4.75 12a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0",
    "M10.75 12a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0",
    "M16.75 12a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0",
  ],
} as const satisfies Record<string, readonly string[]>;

export type ControlGlyphName = keyof typeof CONTROL_GLYPHS;

export type ControlIconProps = {
  name: ControlGlyphName;
  /** Width and height in dp; never follows the font scale. */
  size?: number;
  color: string;
  /** Fills the shape too (the play triangle on a thumbnail). */
  filled?: boolean;
  /** With `filled`: the fill's own color, inside a stroke of `color` (a given star). */
  fillColor?: string;
  testID?: string;
};

const DEFAULT_SIZE = 24;

/** A control's glyph. Decorative: the control around it carries the name and the state. */
export function ControlIcon({
  name,
  size = DEFAULT_SIZE,
  color,
  filled = false,
  fillColor = color,
  testID,
}: ControlIconProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLYPH_VIEW_BOX} ${GLYPH_VIEW_BOX}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      {CONTROL_GLYPHS[name].map((d) => (
        <Path
          key={d}
          d={d}
          fill={filled ? fillColor : "none"}
          stroke={color}
          strokeWidth={GLYPH_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
