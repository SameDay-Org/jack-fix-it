import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { PixelRatio } from "react-native";
import { useReducedMotion, withTiming } from "react-native-reanimated";

import { tokens } from "@/theme";

import { Milestones, sharedLabelMultiplier } from "../Milestones";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withTiming: jest.fn(actual.withTiming),
  };
});

const LABELS = ["On the way", "Arrived", "Done"] as const;

const ui = (reached: number) => (
  <Milestones
    labels={LABELS}
    reached={reached}
    label="Job progress"
    valueText={`Step ${reached} of 3`}
    testID="milestones"
  />
);

/** The fill's horizontal scale in segment `n` (1-based): 0 empty, 1 full. */
const scaleX = (n: number) =>
  (
    screen.getByTestId(`milestones-segment-${n}-fill`).props.jestAnimatedStyle as {
      value: { transform: { scaleX: number }[] };
    }
  ).value.transform[0].scaleX;

const scales = () => [1, 2, 3].map(scaleX);

/** Reanimated's mappers start on the next frame under Jest. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withTiming).mockClear();
});

describe("Milestones", () => {
  it("draws one segment and one label per milestone", async () => {
    await render(ui(1));

    for (const [index, text] of LABELS.entries()) {
      expect(screen.getByTestId(`milestones-segment-${index + 1}`)).toBeTruthy();
      expect(screen.getByTestId(`milestones-segment-${index + 1}-fill`)).toBeTruthy();
      expect(screen.getByTestId(`milestones-label-${index + 1}`).props.children).toBe(text);
    }
    expect(screen.queryByTestId("milestones-segment-4")).toBeNull();
    expect(screen.queryByTestId("milestones-label-4")).toBeNull();
  });

  it("writes the reached labels in navy-900 semibold and the next ones in gray-500", async () => {
    await render(ui(2));

    const className = (n: number): string =>
      screen.getByTestId(`milestones-label-${n}`).props.className;
    for (const n of [1, 2]) {
      expect(className(n)).toContain("font-semibold");
      expect(className(n)).toContain("text-navy-900");
      expect(className(n)).not.toContain("text-gray-500");
    }
    expect(className(3)).toContain("text-gray-500");
    expect(className(3)).not.toContain("text-navy-900");
    expect(className(3)).not.toContain("font-semibold");
  });

  it("is a single progress bar to assistive technology, with its name and value", async () => {
    await render(ui(2));

    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    const [bar] = bars;
    expect(bar).toBe(screen.getByRole("progressbar", { name: "Job progress" }));
    expect(bar.props.accessible).toBe(true);
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 3, now: 2, text: "Step 2 of 3" });
  });

  it.each([
    [0, [0, 0, 0]],
    [1, [1, 0, 0]],
    [2, [1, 1, 0]],
    [3, [1, 1, 1]],
  ])("shows %d reached from the first frame: fills %j", async (reached, filled) => {
    await render(ui(reached));
    await nextFrame();

    expect(scales()).toEqual(filled);
  });

  it("fills the segments in turn over the step token on a change", async () => {
    const view = await render(ui(1));
    await nextFrame();
    expect(scales()).toEqual([1, 0, 0]);

    await view.rerender(ui(3));

    expect(withTiming).toHaveBeenLastCalledWith(3, { duration: tokens.motion.stepSlideMs });
    await waitFor(() => expect(scales()).toEqual([1, 1, 1]));
    expect(screen.getByRole("progressbar").props.accessibilityValue.now).toBe(3);
  });

  it("empties the segments when the progress goes back", async () => {
    const view = await render(ui(3));
    await nextFrame();

    await view.rerender(ui(1));

    await waitFor(() => expect(scales()).toEqual([1, 0, 0]));
    expect(screen.getByTestId("milestones-label-2").props.className).toContain("text-gray-500");
  });

  it("jumps under Reduce Motion", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    const view = await render(ui(0));
    await nextFrame();
    expect(scales()).toEqual([0, 0, 0]);

    await view.rerender(ui(2));
    await nextFrame();

    expect(withTiming).not.toHaveBeenCalled();
    expect(scales()).toEqual([1, 1, 0]);
  });
});

// #486: each label shrank on its own at font scale 2, so "On the way" was drawn smaller than
// "Working" and "Done" next to it.
describe("Milestones at large text", () => {
  const layout = (width: number) => ({
    nativeEvent: { layout: { x: 0, y: 0, width, height: 18 } },
  });
  const caps = () =>
    [1, 2, 3].map(
      (n) => screen.getByTestId(`milestones-label-${n}`).props.maxFontSizeMultiplier as unknown,
    );
  const hidden = { includeHiddenElements: true };

  it("shares the largest cap at which the widest label fits, on a whole pixel", () => {
    // 13 dp at density 1 is 13 px unscaled; the widest label (60 of a 72 dp column) fits 15.6 px.
    const cap = sharedLabelMultiplier(72, [60, 40, 30], 13, 1) as number;
    expect(Math.ceil(13 * cap)).toBe(15);
    // At density 2: 26 px unscaled, 31.2 px fit, 31 px drawn.
    expect(Math.ceil(26 * (sharedLabelMultiplier(72, [60, 40, 30], 13, 2) as number))).toBe(31);
  });

  it("is never under 1, which React Native ignores, and waits for every measure", () => {
    expect(sharedLabelMultiplier(50, [60, 40], 13, 1)).toBe(1);
    expect(sharedLabelMultiplier(0, [60, 40], 13, 1)).toBeUndefined();
    expect(sharedLabelMultiplier(72, [60, undefined], 13, 1)).toBeUndefined();
    expect(sharedLabelMultiplier(72, [60, 0], 13, 1)).toBeUndefined();
    expect(sharedLabelMultiplier(72, [], 13, 1)).toBeUndefined();
  });

  it("gives every label the same cap once the column and the labels are measured", async () => {
    await render(ui(1));
    expect(caps()).toEqual([undefined, undefined, undefined]);

    await act(async () => {
      await fireEvent(screen.getByTestId("milestones-label-1"), "layout", layout(96));
      for (const [index, width] of [64, 48, 32].entries()) {
        await fireEvent(
          screen.getByTestId(`milestones-measure-${index + 1}`, hidden),
          "layout",
          layout(width),
        );
      }
    });

    const shared = sharedLabelMultiplier(
      96,
      [64, 48, 32],
      tokens.fontSize.footnote.size,
      PixelRatio.get(),
    );
    expect(shared).toBeGreaterThan(1);
    expect(caps()).toEqual([shared, shared, shared]);
  });

  it("measures each label unscaled and out of reach of assistive technology", async () => {
    await render(ui(1));

    for (const [index, text] of LABELS.entries()) {
      const measure = screen.getByTestId(`milestones-measure-${index + 1}`, hidden);
      expect(measure.props.children).toBe(text);
      expect(measure.props.allowFontScaling).toBe(false);
      expect(screen.queryByTestId(`milestones-measure-${index + 1}`)).toBeNull();
    }
  });
});
