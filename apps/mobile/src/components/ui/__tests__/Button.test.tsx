import { fireEvent, render, screen } from "@testing-library/react-native";

import "@/i18n";

import { Button } from "../Button";

describe("Button", () => {
  it("calls onPress when enabled", async () => {
    const onPress = jest.fn();
    await render(<Button label="Save" onPress={onPress} />);

    await fireEvent.press(screen.getByRole("button", { name: "Save" }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not call onPress when disabled", async () => {
    const onPress = jest.fn();
    await render(<Button label="Save" onPress={onPress} disabled />);
    const button = screen.getByRole("button", { name: "Save" });

    await fireEvent.press(button);

    expect(onPress).not.toHaveBeenCalled();
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("shows spinner and ignores presses while loading", async () => {
    const onPress = jest.fn();
    await render(<Button label="Save" onPress={onPress} loading />);
    const button = screen.getByRole("button", { name: "Save, Loading" });

    await fireEvent.press(button);

    expect(onPress).not.toHaveBeenCalled();
    expect(button.props.accessibilityState).toMatchObject({ busy: true });
    expect(button.queryAll((node) => node.type === "ActivityIndicator")).toHaveLength(1);
  });

  it("exposes label as accessible name with role button", async () => {
    await render(<Button label="Continue" />);

    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });
});
