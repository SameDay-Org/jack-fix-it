import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import { bubbleShadow, pressedTransform } from "@/theme";

import { Chip, ChipSkeleton } from "../Chip";

const chip = () => screen.getByRole("button", { name: "Painting" });

describe("Chip", () => {
  it("is a button with its label", async () => {
    await render(<Chip label="Painting" onPress={jest.fn()} />);

    expect(chip()).toHaveTextContent("Painting");
    expect(chip().props.accessibilityState).toMatchObject({ disabled: false });
    expect(chip().props.className).toContain("min-h-12"); // the 48 dp target
    expect(chip().props.className).toContain("rounded-pill");
    expect(StyleSheet.flatten(chip().props.style)).toMatchObject(bubbleShadow);
  });

  it("calls onPress and shrinks while pressed", async () => {
    const onPress = jest.fn();
    await render(<Chip label="Painting" onPress={onPress} />);

    await fireEvent(chip(), "pressIn");
    expect(StyleSheet.flatten(chip().props.style)).toMatchObject(pressedTransform);
    await fireEvent(chip(), "pressOut");
    await fireEvent.press(chip());

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(StyleSheet.flatten(chip().props.style).transform).toBeUndefined();
  });

  it("exposes disabled and ignores presses", async () => {
    const onPress = jest.fn();
    await render(<Chip label="Painting" onPress={onPress} disabled />);

    expect(chip().props.accessibilityState).toMatchObject({ disabled: true });
    expect(chip().props.className).toContain("opacity-50");
    await fireEvent.press(chip());
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("ChipSkeleton", () => {
  it("has the chip's shape and an invisible label line of the given width", async () => {
    await render(<ChipSkeleton labelWidth={96} testID="skeleton" />);

    const shape = screen.getByTestId("skeleton-shape");
    expect(shape.props.className).toContain("min-h-12");
    expect(shape.props.className).toContain("rounded-pill");
    expect(screen.queryByRole("button")).toBeNull();
    expect(StyleSheet.flatten(screen.getByText(" ").props.style)).toMatchObject({ width: 96 });
  });
});
