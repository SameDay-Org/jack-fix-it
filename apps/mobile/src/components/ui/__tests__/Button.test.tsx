import { fireEvent, render, screen } from "@testing-library/react-native";

import "@/i18n";

import { Button } from "../Button";

const button = (name: string) => screen.getByRole("button", { name });

describe("Button", () => {
  it("calls onPress when enabled", async () => {
    const onPress = jest.fn();
    await render(<Button label="Save" onPress={onPress} />);

    await fireEvent.press(button("Save"));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not call onPress when disabled", async () => {
    const onPress = jest.fn();
    await render(<Button label="Save" onPress={onPress} disabled />);

    await fireEvent.press(button("Save"));

    expect(onPress).not.toHaveBeenCalled();
    expect(button("Save").props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("shows spinner and ignores presses while loading", async () => {
    const onPress = jest.fn();
    await render(<Button label="Save" onPress={onPress} loading />);

    await fireEvent.press(button("Save, Loading"));

    expect(onPress).not.toHaveBeenCalled();
    expect(button("Save, Loading").props.accessibilityState).toMatchObject({ busy: true });
    expect(
      button("Save, Loading").queryAll((node) => node.type === "ActivityIndicator"),
    ).toHaveLength(1);
  });

  it("exposes label as accessible name with role button", async () => {
    await render(<Button label="Continue" />);

    expect(button("Continue")).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });

  it("primary uses navy label on green and white label when pressed", async () => {
    await render(<Button label="Save" onPress={jest.fn()} />);
    expect(button("Save").props.className).toContain("bg-green-500");
    expect(screen.getByText("Save").props.className).toContain("text-navy-900");

    await fireEvent(button("Save"), "pressIn");

    expect(button("Save").props.className).toContain("bg-green-700");
    expect(screen.getByText("Save").props.className).toContain("text-white");

    await fireEvent(button("Save"), "pressOut");

    expect(button("Save").props.className).toContain("bg-green-500");
    expect(screen.getByText("Save").props.className).toContain("text-navy-900");
  });

  it("is a pill in headline type with 48 dp (md) and 56 dp (lg) targets", async () => {
    await render(
      <>
        <Button label="Medium" />
        <Button label="Large" size="lg" />
        <Button label="Outline" variant="secondary" />
      </>,
    );

    expect(button("Medium").props.className).toContain("rounded-pill");
    expect(button("Medium").props.className).toContain("min-h-12 min-w-12");
    expect(button("Large").props.className).toContain("min-h-14 min-w-14");
    expect(button("Outline").props.className).toContain("border-2 border-navy-900");
    expect(button("Medium").props.style).toMatchObject({ borderCurve: "continuous" });
    expect(screen.getByText("Medium").props.className).toContain("text-headline");
  });
});
