import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import {
  advanceAnimationByTime,
  getAnimatedStyle,
  useReducedMotion,
  withDelay,
  withReanimatedTimer,
  withSequence,
  withTiming,
} from "react-native-reanimated";

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

const WORDS = ["fix", "clean", "mow"];
const WIDTHS = [48, 90, 70];
const INTERVAL = 500;
const TRANSITION = 200;
const LINE = tokens.fontSize.display.lineHeight;

/** Lays out the invisible measurement row, as the native side would. */
function measure() {
  const row = screen.getByTestId("rot-measure");
  WORDS.forEach((word, index) => {
    fireEvent(within(row).getByText(word), "layout", {
      nativeEvent: { layout: { width: WIDTHS[index], height: LINE, x: 0, y: 0 } },
    });
  });
}

function renderRotator(props: Partial<React.ComponentProps<typeof WordRotator>> = {}) {
  return render(
    <WordRotator
      words={WORDS}
      type="display"
      className="text-green-500"
      intervalMs={INTERVAL}
      transitionMs={TRANSITION}
      testID="rot"
      {...props}
    />,
  );
}

const word = (index: number) => screen.getByTestId(`rot-word-${index}`);

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withTiming).mockClear();
  jest.mocked(withDelay).mockClear();
  jest.mocked(withSequence).mockClear();
});

describe("WordRotator", () => {
  it("hides the rotating words from accessibility and clips to one scaled line", async () => {
    await renderRotator();

    const root = screen.getByTestId("rot");
    expect(root.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(root.props.accessibilityElementsHidden).toBe(true);
    expect(screen.getByTestId("rot-clip").props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: LINE, overflow: "hidden" })]),
    );
    expect(word(0).props.numberOfLines).toBe(1);
    expect(word(0).props.className).toContain("text-display");
    expect(word(0).props.className).toContain("text-green-500");
  });

  it("starts only once every word is measured, as one UI-thread sequence of timed steps", async () => {
    const onReady = jest.fn();
    await renderRotator({ onReady });
    expect(onReady).not.toHaveBeenCalled();
    expect(withSequence).not.toHaveBeenCalled();

    await act(async () => measure());

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(withSequence).toHaveBeenCalledTimes(1);
    expect(withDelay).toHaveBeenCalledTimes(WORDS.length); // every word once, back to the first
    expect(jest.mocked(withDelay).mock.calls.map(([delay]) => delay)).toEqual(
      Array(WORDS.length).fill(INTERVAL - TRANSITION),
    );
    expect(jest.mocked(withTiming).mock.calls.map(([target]) => target)).toEqual([1, 2, 3]);
    for (const [, config] of jest.mocked(withTiming).mock.calls) {
      expect(config).toMatchObject({ duration: TRANSITION });
    }
  });

  it("cycles words in order and ends on stopAt, animating the clip width between words", async () => {
    await withReanimatedTimer(async () => {
      const onCycle = jest.fn();
      await renderRotator({ onCycle, stopAt: 0 });
      await act(async () => measure());

      expect(getAnimatedStyle(screen.getByTestId("rot-clip"))).toMatchObject({ width: WIDTHS[0] });
      expect(getAnimatedStyle(word(0))).toMatchObject({ opacity: 1 });
      expect(getAnimatedStyle(word(1))).toMatchObject({ opacity: 0 });

      await act(async () => advanceAnimationByTime(INTERVAL));
      expect(getAnimatedStyle(screen.getByTestId("rot-clip"))).toMatchObject({ width: WIDTHS[1] });
      expect(getAnimatedStyle(word(1))).toMatchObject({ opacity: 1 });
      expect(onCycle).toHaveBeenLastCalledWith(1);

      await act(async () => advanceAnimationByTime(INTERVAL * 2));
      expect(getAnimatedStyle(screen.getByTestId("rot-clip"))).toMatchObject({ width: WIDTHS[0] });
      expect(getAnimatedStyle(word(0))).toMatchObject({ opacity: 1 });
      expect(onCycle).toHaveBeenLastCalledWith(0);
      expect(onCycle).toHaveBeenCalledTimes(WORDS.length);
    });
  });

  it("slides the outgoing word up and the incoming one in from below", async () => {
    await withReanimatedTimer(async () => {
      await renderRotator();
      await act(async () => measure());

      await act(async () => advanceAnimationByTime(INTERVAL - TRANSITION / 2));
      const out = getAnimatedStyle(word(0));
      const inc = getAnimatedStyle(word(1));
      expect(out.transform[0].translateY).toBeLessThan(0);
      expect(out.transform[0].translateY).toBeGreaterThan(-LINE);
      expect(inc.transform[0].translateY).toBeGreaterThan(0);
      expect(inc.transform[0].translateY).toBeLessThan(LINE);
      expect(out.opacity + inc.opacity).toBeCloseTo(1, 5);
    });
  });

  it("reduce motion: no translate, opacity only", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await withReanimatedTimer(async () => {
      await renderRotator();
      await act(async () => measure());

      await act(async () => advanceAnimationByTime(INTERVAL - TRANSITION / 2));
      const out = getAnimatedStyle(word(0));
      const inc = getAnimatedStyle(word(1));
      expect(out.transform[0].translateY).toBe(0);
      expect(inc.transform[0].translateY).toBe(0);
      expect(out.opacity).toBeLessThan(1);
      expect(inc.opacity).toBeGreaterThan(0);
    });
  });
});
