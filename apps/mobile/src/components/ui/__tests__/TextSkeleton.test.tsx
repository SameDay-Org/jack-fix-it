import { render, screen } from "@testing-library/react-native";
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
});
