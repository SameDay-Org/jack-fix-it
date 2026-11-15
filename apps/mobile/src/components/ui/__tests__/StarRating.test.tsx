import { fireEvent, render, screen } from "@testing-library/react-native";
import { selectionAsync } from "expo-haptics";
import { useState } from "react";
import { StyleSheet } from "react-native";
import { useReducedMotion, withSpring } from "react-native-reanimated";

import "@/i18n";

import { StarRating, StarsShown, type StarScore } from "../StarRating";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withSpring: jest.fn(actual.withSpring),
  };
});
// The root manual mock (apps/mobile/__mocks__), named so the test and the kit share one instance.
jest.mock("expo-haptics");

const HIDDEN = { includeHiddenElements: true };

type HarnessProps = {
  initial?: StarScore | null;
  clearable?: boolean;
  disabled?: boolean;
  size?: "md" | "lg";
  onChange?: (value: StarScore | null) => void;
};

/** The control as a screen holds it: the value lives in the parent. */
function Harness({ initial = null, clearable, disabled, size, onChange }: HarnessProps) {
  const [value, setValue] = useState<StarScore | null>(initial);
  return (
    <StarRating
      label="Overall rating"
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      clearable={clearable}
      disabled={disabled}
      size={size}
      testID="stars"
    />
  );
}

const control = () => screen.getByRole("adjustable", { name: "Overall rating" });
const tap = (score: number) => fireEvent.press(screen.getByTestId(`stars-${score}`, HIDDEN));
const step = (actionName: "increment" | "decrement") =>
  fireEvent(control(), "accessibilityAction", { nativeEvent: { actionName } });

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withSpring).mockClear();
  jest.mocked(selectionAsync).mockClear();
});

describe("StarRating", () => {
  it("is one adjustable control that says its value: '3 of 5 stars', or 'Not rated'", async () => {
    await render(<Harness />);

    expect(control()).toHaveAccessibilityValue({ min: 0, max: 5, now: 0, text: "Not rated" });
    expect(control().props.accessibilityActions).toEqual([
      { name: "increment" },
      { name: "decrement" },
    ]);
    // The stars are touch targets only: assistive technology hears the row.
    expect(screen.queryByTestId("stars-1")).toBeNull();
    expect(screen.getByTestId("stars-1", HIDDEN).props.accessible).toBe(false);

    await tap(3);
    expect(control()).toHaveAccessibilityValue({ now: 3, text: "3 of 5 stars" });
    await tap(1);
    expect(control()).toHaveAccessibilityValue({ now: 1, text: "1 of 5 stars" });
  });

  it("steps up and down with the screen reader's swipes, within 1 to 5", async () => {
    await render(<Harness />);

    await step("increment");
    expect(control()).toHaveAccessibilityValue({ now: 1 });
    for (let i = 0; i < 6; i += 1) await step("increment");
    expect(control()).toHaveAccessibilityValue({ now: 5, text: "5 of 5 stars" });

    for (let i = 0; i < 6; i += 1) await step("decrement");
    // A required rating never steps back to none.
    expect(control()).toHaveAccessibilityValue({ now: 1 });
  });

  it("as an optional rating, a tap on the given star or a step below one takes it back", async () => {
    const onChange = jest.fn();
    await render(<Harness initial={2} clearable onChange={onChange} />);

    await tap(2);
    expect(control()).toHaveAccessibilityValue({ now: 0, text: "Not rated" });

    await tap(1);
    await step("decrement");
    expect(control()).toHaveAccessibilityValue({ now: 0, text: "Not rated" });
    expect(onChange.mock.calls).toEqual([[null], [1], [null]]);
  });

  it("a required rating keeps its star on a second tap", async () => {
    const onChange = jest.fn();
    await render(<Harness initial={4} onChange={onChange} />);

    await tap(4);

    expect(control()).toHaveAccessibilityValue({ now: 4 });
    expect(onChange).not.toHaveBeenCalled();
    expect(selectionAsync).not.toHaveBeenCalled();
  });

  it("ticks once per change, and the chosen star pops", async () => {
    await render(<Harness />);

    await tap(5);

    expect(selectionAsync).toHaveBeenCalledTimes(1);
    expect(withSpring).toHaveBeenCalled();
  });

  it("does not pop under Reduce Motion, and still changes and ticks", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await render(<Harness />);

    await tap(5);

    expect(control()).toHaveAccessibilityValue({ now: 5 });
    expect(selectionAsync).toHaveBeenCalledTimes(1);
    expect(withSpring).not.toHaveBeenCalled();
  });

  it("changes nothing while disabled, and says so", async () => {
    const onChange = jest.fn();
    await render(<Harness initial={2} disabled onChange={onChange} />);

    await tap(5);
    await step("increment");

    expect(control()).toBeDisabled();
    expect(control()).toHaveAccessibilityValue({ now: 2 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["md", 48],
    ["lg", 56],
  ] as const)("gives each %s star a %i dp touch target", async (size, side) => {
    await render(<Harness size={size} />);

    const style = StyleSheet.flatten(screen.getByTestId("stars-1", HIDDEN).props.style);
    expect(style).toMatchObject({ width: side, height: side });
  });
});

describe("StarsShown", () => {
  it("is hidden from assistive technology: the text beside it says the value", async () => {
    await render(<StarsShown value={4} />);

    expect(screen.toJSON()).toMatchObject({
      props: {
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      },
    });
  });
});
