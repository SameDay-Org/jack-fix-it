import Svg, { Path } from "react-native-svg";

import { GLYPH_STROKE_WIDTH, GLYPH_VIEW_BOX } from "./glyphs";

// Small control glyphs on the icon grid (24 units, round caps), stroke only.
const CONTROL_GLYPHS = {
  plus: ["M12 6v12", "M6 12h12"],
  minus: ["M6 12h12"],
  // A play triangle, for a video's thumbnail.
  play: ["M9 6.5v11l8.5-5.5Z"],
  // A check mark, for a request that went through.
  check: ["M5.5 12.5l4.5 4.5 8.5-10"],
} as const satisfies Record<string, readonly string[]>;

export type ControlGlyphName = keyof typeof CONTROL_GLYPHS;

export type ControlIconProps = {
  name: ControlGlyphName;
  /** Width and height in dp; never follows the font scale. */
  size?: number;
  color: string;
  /** Fills the shape too (the play triangle on a thumbnail). */
  filled?: boolean;
  testID?: string;
};

const DEFAULT_SIZE = 24;

/** A control's glyph. Decorative: the control around it carries the name and the state. */
export function ControlIcon({
  name,
  size = DEFAULT_SIZE,
  color,
  filled = false,
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
          fill={filled ? color : "none"}
          stroke={color}
          strokeWidth={GLYPH_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
