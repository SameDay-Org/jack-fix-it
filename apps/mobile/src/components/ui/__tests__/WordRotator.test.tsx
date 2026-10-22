import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { Dimensions } from "react-native";
import { useReducedMotion, withDelay, withSequence, withTiming } from "react-native-reanimated";

import { tokens } from "@/theme";

import { WordRotator } from "../WordRotator";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withTiming: jest.fn(actual.withTiming),
    withDelay: jest.fn(actual.withDelay),
    withSequence: jest.fn(actual.withSequence),
  };
});

const WORDS = ["fix", "clean", "mow", "move"];
const WIDTHS = [48, 90, 70, 84];
const SWAPS = 3; // fix → clean → mow → fix: the fourth word is never shown
const INTERVAL = 500;
const TRANSITION = 200;
const LINE = 52; // one display line as the native side reports it: here as if scaled by 1.3

// The rotator hides itself from accessibility, so every query here opts into hidden elements.
const HIDDEN = { includeHiddenElements: true };
const clip = () => screen.getByTestId("rot-clip", HIDDEN);
const word = (index: number) => screen.getByTestId(`rot-word-${index}`, HIDDEN);

/** Reanimated keeps a component's live animated style here while running under Jest. */
type Animated = { opacity?: number; width?: number; transform?: { translateY: number }[] };
const animated = (node: { props: Record<string, unknown> }): Animated =>
  (node.props.jestAnimatedStyle as { value: Animated }).value;
const translateY = (node: { props: Record<string, unknown> }) =>
  animated(node).transform?.[0].translateY;

/** Lays out the invisible measurement row, as the native side would. */
async function measure() {
  const row = screen.getByTestId("rot-measure", HIDDEN);
  await act(async () => {
    WORDS.forEach((text, index) => {
      fireEvent(within(row).getByText(text, HIDDEN), "layout", {
        nativeEvent: { layout: { width: WIDTHS[index], height: LINE, x: 0, y: 0 } },
      });
    });
  });
  await advance(16); // one frame: the animated styles pick up the measured widths
}

const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));

function renderRotator(props: Partial<React.ComponentProps<typeof WordRotator>> = {}) {
  return render(
    <WordRotator
      words={WORDS}
      type="display"
      className="text-green-500"
      intervalMs={INTERVAL}
      transitionMs={TRANSITION}
      swaps={SWAPS}
      testID="rot"
      {...props}
    />,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withTiming).mockClear();
  jest.mocked(withDelay).mockClear();
  jest.mocked(withSequence).mockClear();
});
afterEach(() => jest.useRealTimers());

describe("WordRotator", () => {
  it("hides the rotating words from accessibility and clips to one measured line", async () => {
    await renderRotator();

    const root = screen.getByTestId("rot", HIDDEN);
    expect(root.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(root.props.accessibilityElementsHidden).toBe(true);
    // Until the words report their size the clip is one token line tall; then it is as tall as
    // they measured, whatever the platform made of the font scale.
    expect(clip().props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ height: tokens.fontSize.display.lineHeight, overflow: "hidden" }),
      ]),
    );
    await measure();
    expect(clip().props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: LINE, overflow: "hidden" })]),
    );
    expect(word(0).props.numberOfLines).toBe(1);
    expect(word(0).props.className).toContain("text-display");
    expect(word(0).props.className).toContain("text-green-500");
  });

  it("measures each word at its own width: the hidden column must not stretch its words", async () => {
    await renderRotator();

    // Yoga stretches a column's children by default, which would make every word report the
    // widest one's width and freeze the clip there; and an absolute child without a width is
    // measured against its parent, here the clip, which is only as wide as the current word.
    // The layout engine is not under Jest, so pin the styles that prevent both.
    expect(screen.getByTestId("rot-measure", HIDDEN).props.style).toEqual([
      { position: "absolute", opacity: 0, alignItems: "flex-start" },
      { width: Dimensions.get("window").width },
    ]);
    const measureRow = within(screen.getByTestId("rot-measure", HIDDEN));
    for (const text of WORDS) {
      expect(measureRow.getByText(text, HIDDEN).props.numberOfLines).toBe(1);
    }

    // Once measured, the words' stage is as wide as the widest word (plus rounding slack), so a
    // word is never ellipsized by a clip that is narrower than it: the clip clips, nothing else.
    expect(screen.getByTestId("rot-stage", HIDDEN).props.style).toMatchObject({ width: undefined });
    await measure();
    expect(screen.getByTestId("rot-stage", HIDDEN).props.style).toMatchObject({
      position: "absolute",
      width: Math.ceil(Math.max(...WIDTHS)) + 1,
      height: LINE,
    });
  });

  it("starts only once every word is measured, as one UI-thread sequence of timed steps", async () => {
    const onReady = jest.fn();
    await renderRotator({ onReady });
    expect(onReady).not.toHaveBeenCalled();
    expect(withSequence).not.toHaveBeenCalled();

    await measure();

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(withSequence).toHaveBeenCalledTimes(1);
    expect(jest.mocked(withDelay).mock.calls.map(([delay]) => delay)).toEqual(
      Array(SWAPS).fill(INTERVAL - TRANSITION),
    );
    expect(jest.mocked(withTiming).mock.calls.map(([target]) => target)).toEqual([1, 2, 3]);
    for (const [, config] of jest.mocked(withTiming).mock.calls) {
      expect(config).toMatchObject({ duration: TRANSITION });
    }
  });

  it("cycles words in order and ends on stopAt, animating the clip width between words", async () => {
    const onCycle = jest.fn();
    await renderRotator({ onCycle, stopAt: 0 });
    await measure();
    expect(animated(clip()).width).toBe(WIDTHS[0]);
    expect(animated(word(0)).opacity).toBe(1);
    expect(animated(word(1)).opacity).toBe(0);

    await advance(INTERVAL - TRANSITION / 2); // mid swap: the width is on its way, never a snap
    const midway = animated(clip()).width as number;
    expect(midway).toBeGreaterThan(WIDTHS[0]);
    expect(midway).toBeLessThan(WIDTHS[1]);

    await advance(TRANSITION / 2);
    expect(animated(clip()).width).toBe(WIDTHS[1]);
    expect(animated(word(1)).opacity).toBe(1);
    expect(animated(word(0)).opacity).toBe(0);
    expect(onCycle.mock.calls).toEqual([[1]]);

    await advance(INTERVAL * 2);
    expect(animated(clip()).width).toBe(WIDTHS[0]);
    expect(animated(word(0)).opacity).toBe(1);
    expect(animated(word(3)).opacity).toBe(0); // never shown
    expect(onCycle.mock.calls).toEqual([[1], [2], [0]]);
  });

  it("slides: a waiting word sits one line below the clip, ready to roll in", async () => {
    await renderRotator();
    await measure();

    expect(translateY(word(0))).toBe(0);
    expect(translateY(word(1))).toBe(LINE);
  });

  it("reduce motion: no translate, opacity only", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderRotator();
    await measure();

    expect(translateY(word(1))).toBe(0);
    expect(animated(word(1)).opacity).toBe(0);
    await advance(INTERVAL);
    expect(translateY(word(1))).toBe(0);
    expect(animated(word(1)).opacity).toBe(1);
    expect(translateY(word(0))).toBe(0);
    expect(animated(word(0)).opacity).toBe(0);
  });
});
