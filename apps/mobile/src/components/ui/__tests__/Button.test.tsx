import { fireEvent, render, screen, within } from "@testing-library/react-native";

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

  it("with a glyph it is a round icon button that keeps its label as the name", async () => {
    const onPress = jest.fn();
    await render(<Button label="Share" variant="secondary" glyph="share" onPress={onPress} />);

    await fireEvent.press(button("Share"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Share")).toBeNull();
    expect(button("Share").queryAll((node) => node.type === "RNSVGSvgView")).toHaveLength(1);
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

  it("a fuller accessible name replaces the label for assistive technology only", async () => {
    await render(<Button label="Remove" accessibilityLabel="Remove Photo 2" loading />);

    expect(button("Remove Photo 2, Loading")).toBeTruthy();
    expect(screen.getByText("Remove")).toBeTruthy();
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
    expect(screen.getByText("Medium").props.numberOfLines).toBe(1); // one line by contract
  });
});

describe("Button badge (#74)", () => {
  const badgeText = () =>
    within(screen.getByTestId("chat-badge"))
      .getAllByText(/./)
      .map((node) => [node.props.children as string | number].flat().join(""))
      .join("");

  it("shows the count beside the label above zero", async () => {
    await render(<Button label="Message Dan" badge={3} testID="chat" />);

    expect(badgeText()).toBe("3");
    expect(screen.getByText("Message Dan")).toBeTruthy();
  });

  it.each([
    ["zero", 0],
    ["no badge", undefined],
  ] as const)("shows no badge with %s", async (_, badge) => {
    await render(<Button label="Message Dan" badge={badge} testID="chat" />);

    expect(screen.queryByTestId("chat-badge")).toBeNull();
  });

  it("caps the count at 99+", async () => {
    await render(<Button label="Message Dan" badge={150} testID="chat" />);

    expect(badgeText()).toBe("99+");
  });

  it("a glyph button never shows a badge", async () => {
    await render(<Button label="Share" glyph="share" badge={3} testID="chat" />);

    expect(screen.queryByTestId("chat-badge")).toBeNull();
    expect(screen.queryByText("3")).toBeNull();
  });

  it("keeps the caller's accessible name: the count is not appended", async () => {
    await render(
      <>
        <Button label="Message Dan" badge={3} testID="chat" />
        <Button
          label="Reply"
          accessibilityLabel="Reply to Dan, 2 unread messages"
          badge={2}
          testID="reply"
        />
      </>,
    );

    expect(screen.getByTestId("chat").props.accessibilityLabel).toBe("Message Dan");
    expect(screen.getByTestId("reply").props.accessibilityLabel).toBe(
      "Reply to Dan, 2 unread messages",
    );
    expect(button("Message Dan")).toBeTruthy();
  });
});
