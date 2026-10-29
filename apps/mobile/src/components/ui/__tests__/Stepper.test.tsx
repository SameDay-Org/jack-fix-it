import "@/i18n";

import {
  fireEvent,
  isHiddenFromAccessibility,
  render,
  screen,
} from "@testing-library/react-native";
import { useState } from "react";

import { Stepper } from "../Stepper";

const stepper = () => screen.getByRole("adjustable", { name: "Bedrooms" });
// The buttons are hidden from accessibility (touch only), so their queries opt into hidden elements.
const hidden = { includeHiddenElements: true };
const plus = () => screen.getByTestId("rooms-increase", hidden);
const minus = () => screen.getByTestId("rooms-decrease", hidden);
const value = () => screen.getByTestId("rooms-value");

/** A stepper that keeps its own value, as a screen holding the answer would. */
function Harness({
  start,
  min = 0,
  max = 2,
}: {
  start: number | null;
  min?: number;
  max?: number;
}) {
  const [current, setCurrent] = useState(start);
  return (
    <Stepper
      label="Bedrooms"
      value={current}
      min={min}
      max={max}
      onChange={setCurrent}
      testID="rooms"
    />
  );
}

const act = (actionName: "increment" | "decrement") =>
  fireEvent(stepper(), "accessibilityAction", { nativeEvent: { actionName } });

describe("Stepper", () => {
  it("starts empty: a blank value, minus off, and 'Not set' for screen readers", async () => {
    await render(<Harness start={null} />);

    expect(value()).toHaveTextContent("");
    expect(stepper().props.accessibilityValue).toEqual({ text: "Not set" });
    expect(minus().props.accessibilityState).toMatchObject({ disabled: true });
    expect(minus().props.className).toContain("opacity-40");
    expect(plus().props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("the first plus gives the minimum, then counts up to the maximum and stops", async () => {
    await render(<Harness start={null} min={1} max={2} />);

    await fireEvent.press(plus());
    expect(value()).toHaveTextContent("1");
    await fireEvent.press(plus());
    expect(value()).toHaveTextContent("2");
    expect(plus().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(plus());
    expect(value()).toHaveTextContent("2");
    expect(stepper().props.accessibilityValue).toEqual({ min: 1, max: 2, now: 2, text: "2" });
  });

  it("counts down to the minimum and stops there", async () => {
    await render(<Harness start={1} min={0} />);

    await fireEvent.press(minus());
    expect(value()).toHaveTextContent("0");
    expect(minus().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(minus());
    expect(value()).toHaveTextContent("0");
  });

  it("is one adjustable control for screen readers: swipe up and down change the value", async () => {
    await render(<Harness start={null} max={1} />);

    expect(stepper().props.accessible).toBe(true);
    expect(stepper().props.accessibilityActions).toEqual([
      { name: "increment" },
      { name: "decrement" },
    ]);
    await act("increment");
    expect(value()).toHaveTextContent("0");
    await act("increment");
    await act("increment"); // past the maximum: nothing
    expect(value()).toHaveTextContent("1");
    await act("decrement");
    expect(value()).toHaveTextContent("0");
  });

  it("screen readers reach exactly one control: the buttons are touch only", async () => {
    await render(<Harness start={1} />);

    expect(screen.getAllByRole("adjustable")).toHaveLength(1);
    // Hidden from the accessibility tree, so the default (accessible-only) query cannot reach them.
    expect(screen.queryByTestId("rooms-increase", { includeHiddenElements: false })).toBeNull();
    expect(screen.queryByTestId("rooms-decrease", { includeHiddenElements: false })).toBeNull();
    for (const button of [plus(), minus()]) {
      expect(isHiddenFromAccessibility(button)).toBe(true);
      expect(button.props).toMatchObject({
        accessible: false,
        focusable: false,
        importantForAccessibility: "no",
        accessibilityElementsHidden: true,
      });
    }
    await fireEvent.press(plus()); // touch still works
    expect(value()).toHaveTextContent("2");
  });

  it("takes the danger ring when invalid, and 48 dp buttons either way", async () => {
    await render(
      <Stepper
        label="Bedrooms"
        value={null}
        min={0}
        max={3}
        onChange={jest.fn()}
        invalid
        testID="rooms"
      />,
    );

    expect(stepper().props.className).toContain("border-danger");
    for (const button of [plus(), minus()]) {
      expect(button.props.className).toContain("h-12");
      expect(button.props.className).toContain("w-12");
    }
  });
});
