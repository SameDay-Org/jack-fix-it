import "@/i18n";

import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { Text } from "react-native";

import { tokens } from "@/theme";

import { BrandHero } from "../BrandHero";

const HIDDEN = { includeHiddenElements: true };
const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
const headline = () => screen.getByTestId("hero");

describe("BrandHero", () => {
  it("wordmark, one accessible sentence with the first word, the given word in place, support line", async () => {
    await render(<BrandHero word={<Text testID="word">fix</Text>} testID="hero" />);

    expect(screen.getByText("Jack Fix It")).toBeTruthy();
    expect(
      screen.getByRole("header", { name: "Whatever happens at home, we fix it." }),
    ).toBeTruthy();
    expect(within(headline()).getByTestId("word", HIDDEN)).toBeTruthy();
    expect(screen.getByText("Tell Jack. We'll take care of the rest.")).toBeTruthy();
    expect(screen.getAllByRole("header")).toHaveLength(1);
    // The sentence is announced once: the words are not accessibility nodes, and the word slot
    // hides whatever rolls inside it.
    for (const piece of ["Whatever", "happens", "at", "home,", "we", "it."]) {
      expect(screen.getByText(piece, HIDDEN).props.importantForAccessibility).toBe("no");
    }
    expect(screen.getByTestId("hero-word", HIDDEN).props.importantForAccessibility).toBe(
      "no-hide-descendants",
    );
    expect(screen.queryByText("fix")).toBeNull(); // hidden from the reader, there for the eye
    expect(screen.getByText("fix", HIDDEN)).toBeTruthy();
  });

  it("spaces the words by the font's own space, measured; a type-based guess until then", async () => {
    await render(<BrandHero word={<Text>fix</Text>} testID="hero" />);
    expect(headline().props.style).toMatchObject({ columnGap: tokens.fontSize.display.size / 4 });

    const gauge = within(screen.getByTestId("hero-gauge", HIDDEN));
    await act(async () => {
      fireEvent(gauge.getByText("x x", HIDDEN), "layout", layout(49.5));
      fireEvent(gauge.getByText("xx", HIDDEN), "layout", layout(40));
    });

    expect(headline().props.style).toMatchObject({ columnGap: 9.5 });
    expect(screen.getByTestId("hero-gauge", HIDDEN).props.importantForAccessibility).toBe(
      "no-hide-descendants",
    );
  });
});
