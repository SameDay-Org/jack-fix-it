import { render, screen } from "@testing-library/react-native";
import { processColor } from "react-native";

import { tokens } from "@/theme";

import { ControlIcon } from "../ControlIcon";
import { GLYPH_STROKE_WIDTH, GLYPH_VIEW_BOX } from "../glyphs";

// The icon hides itself from accessibility, so queries for it opt into hidden elements.
const HIDDEN = { includeHiddenElements: true };
const svg = () => screen.getByTestId("icon", HIDDEN);
const paths = () => svg().queryAll((node) => node.type === "RNSVGPath");
const NAVY = tokens.colors["navy-900"];

describe("ControlIcon", () => {
  it.each(["plus", "minus", "play"] as const)(
    "%s is drawn on the icon grid with the set's stroke and hidden from screen readers",
    async (name) => {
      await render(<ControlIcon name={name} color={NAVY} testID="icon" />);

      expect(screen.queryByTestId("icon")).toBeNull(); // not reachable without opting in
      expect(svg().props.vbWidth).toBe(GLYPH_VIEW_BOX);
      expect(paths().length).toBeGreaterThan(0);
      for (const path of paths()) {
        expect(path.props.strokeWidth).toBe(GLYPH_STROKE_WIDTH);
        expect(path.props.stroke).toEqual({ type: 0, payload: processColor(NAVY) });
      }
    },
  );

  it("fills the shape only when asked (the play mark on a video thumbnail)", async () => {
    await render(<ControlIcon name="play" color={NAVY} filled testID="icon" />);
    expect(paths()[0]?.props.fill).toEqual({ type: 0, payload: processColor(NAVY) });

    await render(<ControlIcon name="plus" color={NAVY} testID="icon" />);
    expect(paths().every((path) => path.props.fill == null)).toBe(true);
  });
});
