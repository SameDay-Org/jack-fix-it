import { render, screen } from "@testing-library/react-native";

import { ACCOUNT_GLYPHS, type AccountGlyphName } from "../accountGlyphs";
import { CategoryIcon } from "../CategoryIcon";
import { GLYPH_STROKE_WIDTH } from "../glyphs";

const HIDDEN = { includeHiddenElements: true };
const NAMES = Object.keys(ACCOUNT_GLYPHS) as AccountGlyphName[];

describe("ACCOUNT_GLYPHS", () => {
  it("has the Account menu's four glyphs", () => {
    expect(NAMES).toEqual(["settings", "help", "legal", "logOut"]);
  });

  it.each(NAMES)(
    "%s paints in the category set's style: accent first, then strokes",
    async (name) => {
      await render(<CategoryIcon slug="" glyph={ACCOUNT_GLYPHS[name]} size={24} testID="icon" />);

      const paths = screen
        .getByTestId("icon", HIDDEN)
        .queryAll((node) => node.type === "RNSVGPath", HIDDEN);
      expect(paths[0].props.d).toBe(ACCOUNT_GLYPHS[name].accent);
      expect(paths.slice(1).map((path) => path.props.d)).toEqual(ACCOUNT_GLYPHS[name].strokes);
      for (const path of paths.slice(1)) expect(path.props.strokeWidth).toBe(GLYPH_STROKE_WIDTH);
    },
  );
});
