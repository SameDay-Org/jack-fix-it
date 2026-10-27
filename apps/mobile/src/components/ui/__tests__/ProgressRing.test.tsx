import { render, screen } from "@testing-library/react-native";
import { useReducedMotion, withTiming } from "react-native-reanimated";

import { tokens } from "@/theme";

import { ProgressRing } from "../ProgressRing";

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

const ring = () => screen.getByRole("progressbar", { name: "Photo 1" });

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withTiming).mockClear();
});

describe("ProgressRing", () => {
  it("is a named progress bar whose value is the percentage", async () => {
    await render(<ProgressRing progress={0.42} accessibilityLabel="Photo 1" />);

    expect(ring().props.accessibilityValue).toEqual({ min: 0, max: 100, now: 42 });
  });

  it.each([
    [-0.5, 0],
    [1.7, 100],
  ])("clamps %d to %d%%", async (progress, now) => {
    await render(<ProgressRing progress={progress} accessibilityLabel="Photo 1" />);

    expect(ring().props.accessibilityValue.now).toBe(now);
  });

  it.each([0.1, 0.9])("keeps its size at %d, so nothing around it moves", async (progress) => {
    await render(<ProgressRing progress={progress} accessibilityLabel="Photo 1" size={48} />);

    expect(ring().props.style).toEqual({ width: 48, height: 48 });
  });

  it("eases to a new value over the transition token, and jumps under Reduce Motion", async () => {
    const view = await render(<ProgressRing progress={0.2} accessibilityLabel="Photo 1" />);
    await view.rerender(<ProgressRing progress={0.6} accessibilityLabel="Photo 1" />);
    expect(withTiming).toHaveBeenLastCalledWith(0.6, { duration: tokens.motion.transitionMs });

    jest.mocked(withTiming).mockClear();
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await view.rerender(<ProgressRing progress={0.8} accessibilityLabel="Photo 1" />);
    expect(withTiming).not.toHaveBeenCalled();
  });
});
