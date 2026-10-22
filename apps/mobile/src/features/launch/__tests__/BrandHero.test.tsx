import "@/i18n";

import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { Text } from "react-native";

import { BrandHero, resetHeroMeasurementsForTests } from "../BrandHero";

const HIDDEN = { includeHiddenElements: true };
// The emulator's numbers at 320 dp: every static word, every word the rotator can show, the gauge.
const WIDTHS: Record<string, number> = {
  Whatever: 145,
  happens: 131,
  at: 30,
  "home,": 95,
  we: 44,
  "it.": 31,
  fix: 39,
  clean: 83,
  paint: 78,
  mow: 74,
  move: 84,
  "x x": 49,
  xx: 40,
};
const LINE = 40;
const ROW = 272;

const headline = () => screen.getByTestId("hero");
const lineTexts = () => {
  const lines: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const line = screen.queryByTestId(`hero-line-${i}`, HIDDEN);
    if (!line) break;
    lines.push(
      within(line)
        .getAllByText(/./, HIDDEN)
        .map((node) => (node.props.children as string).trim())
        .join(" "),
    );
  }
  return lines;
};

/** Lays the measurement row and the headline row out, as the native side would. */
async function measureAll() {
  const gauge = within(screen.getByTestId("hero-gauge", HIDDEN));
  await act(async () => {
    for (const [text, width] of Object.entries(WIDTHS)) {
      fireEvent(gauge.getByText(text, HIDDEN), "layout", {
        nativeEvent: { layout: { x: 0, y: 0, width, height: LINE } },
      });
    }
    fireEvent(headline(), "layout", {
      nativeEvent: { layout: { x: 24, y: 189, width: ROW, height: 120 } },
    });
  });
}

describe("BrandHero", () => {
  beforeEach(resetHeroMeasurementsForTests);

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
      expect(screen.getAllByText(piece, HIDDEN)[0].props.importantForAccessibility).toBe("no");
    }
    expect(screen.getByTestId("hero-word", HIDDEN).props.importantForAccessibility).toBe(
      "no-hide-descendants",
    );
    expect(screen.queryByText("fix")).toBeNull(); // hidden from the reader, there for the eye
  });

  it("lays the lines out from the measured words with the slot at its widest, and keeps them whatever word shows", async () => {
    const { rerender } = await render(<BrandHero word={<Text>fix</Text>} testID="hero" />);
    expect(screen.queryByTestId("hero-line-0", HIDDEN)).toBeNull(); // wraps until measured

    await measureAll();

    // "home, we [move] it." is 281 > 272 on this phone: "it." gets its own line, for every word.
    expect(lineTexts()).toEqual(["Whatever", "happens at", "home, we fix", "it."]);
    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`hero-line-${i}`, HIDDEN).props.style).toMatchObject({
        height: LINE,
        columnGap: 9,
      });
    }

    await rerender(<BrandHero word={<Text>clean</Text>} testID="hero" />);
    expect(lineTexts()).toEqual(["Whatever", "happens at", "home, we clean", "it."]);
    await rerender(<BrandHero word={<Text>paint</Text>} testID="hero" />);
    expect(lineTexts()).toHaveLength(4); // same lines, same height: nothing below the headline moves
  });

  it("the gauge is hidden from accessibility and measures every word once", async () => {
    await render(<BrandHero word={<Text>fix</Text>} testID="hero" />);
    const gauge = screen.getByTestId("hero-gauge", HIDDEN);
    expect(gauge.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(within(gauge).getAllByText(/./, HIDDEN)).toHaveLength(Object.keys(WIDTHS).length);
  });

  it("is transparent until its rows are laid out, then reports it once, from the first row's own layout", async () => {
    const onLaidOut = jest.fn();
    await render(<BrandHero word={<Text>fix</Text>} onLaidOut={onLaidOut} testID="hero" />);
    // Before measurement the wrapping fallback exists only to give the header a width: never painted.
    expect(screen.getByTestId("hero-frame", HIDDEN).props.style).toMatchObject({ opacity: 0 });

    await measureAll();
    expect(screen.getByTestId("hero-frame", HIDDEN).props.style).toMatchObject({ opacity: 1 });
    // The rows exist in the commit; the native side has not laid them out yet.
    expect(onLaidOut).not.toHaveBeenCalled();

    const row = screen.getByTestId("hero-line-0", HIDDEN);
    const laidOut = { nativeEvent: { layout: { x: 0, y: 0, width: ROW, height: LINE } } };
    await act(async () => fireEvent(row, "layout", laidOut));
    await act(async () => fireEvent(row, "layout", laidOut));
    expect(onLaidOut).toHaveBeenCalledTimes(1);
  });

  it("a second hero at the same width lays its lines out on its first render, from the first one's measurements", async () => {
    const first = await render(<BrandHero word={<Text>fix</Text>} testID="hero" />);
    await measureAll();
    expect(lineTexts()).toHaveLength(4);
    await first.unmount();

    // Welcome mounts under the intro once the session is known: no transparent, measuring frame.
    const onLaidOut = jest.fn();
    await render(<BrandHero word={<Text>fix</Text>} onLaidOut={onLaidOut} testID="hero" />);
    expect(lineTexts()).toHaveLength(4);
    expect(screen.getByTestId("hero-frame", HIDDEN).props.style).toMatchObject({ opacity: 1 });
    expect(onLaidOut).not.toHaveBeenCalled(); // still the native side's call
  });
});
