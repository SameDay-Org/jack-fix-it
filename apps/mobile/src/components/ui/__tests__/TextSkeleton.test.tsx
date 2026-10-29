import { act, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import "@/i18n";

import { tokens } from "@/theme";

import { TextSkeleton } from "../TextSkeleton";

describe("TextSkeleton", () => {
  it.each(["title-1", "callout", "caption"] as const)(
    "is one invisible %s line, with a bar as tall as the type's font size",
    async (type) => {
      await render(<TextSkeleton type={type} width="60%" testID="line" />);

      const line = screen.getByTestId("line", { includeHiddenElements: true });
      const [text] = line.queryAll((node) => node.type === "Text");
      // The line takes the type style's height at any font scale; nobody reads or sees it.
      expect(text.props.className).toBe(`text-${type} opacity-0`);
      expect(text.props.importantForAccessibility).toBe("no-hide-descendants");

      const bar = screen.getByRole("progressbar", { name: "Loading" });
      const shape = bar.queryAll((node) => node.type === "View")[0];
      expect(StyleSheet.flatten(shape.props.style)).toMatchObject({
        width: "60%",
        height: tokens.fontSize[type].size,
      });
    },
  );

  it("with a sample, the invisible sample sizes the box and a bar covers each laid-out line", async () => {
    await render(<TextSkeleton type="headline" sample="Reparaciones generales" testID="line" />);
    const line = screen.getByTestId("line", { includeHiddenElements: true });
    const [text] = line.queryAll((node) => node.type === "Text");
    expect(text.props.children).toBe("Reparaciones generales");
    expect(text.props.importantForAccessibility).toBe("no-hide-descendants");
    // Before the text is laid out: one bar across the box.
    expect(screen.getAllByRole("progressbar", { name: "Loading" })).toHaveLength(1);

    const lines = [
      {
        x: 0,
        y: 0,
        width: 120,
        height: 22,
        ascender: 16,
        descender: 4,
        capHeight: 12,
        xHeight: 9,
        text: "Reparaciones",
      },
      {
        x: 0,
        y: 22,
        width: 80,
        height: 22,
        ascender: 16,
        descender: 4,
        capHeight: 12,
        xHeight: 9,
        text: "generales",
      },
    ];
    await act(async () => text.props.onTextLayout({ nativeEvent: { lines } }));

    const bars = screen.getAllByRole("progressbar", { name: "Loading" });
    expect(bars).toHaveLength(2);
    const size = tokens.fontSize.headline.size;
    bars.forEach((bar, index) => {
      expect(StyleSheet.flatten(bar.parent?.props.style)).toMatchObject({
        left: 0,
        top: lines[index]!.y + (22 - size) / 2,
        width: lines[index]!.width,
      });
      const shape = bar.queryAll((node) => node.type === "View")[0];
      expect(StyleSheet.flatten(shape.props.style)).toMatchObject({ width: "100%", height: size });
    });
  });
});
