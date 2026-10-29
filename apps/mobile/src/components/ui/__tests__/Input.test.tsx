import { fireEvent, render, screen } from "@testing-library/react-native";
import { createRef } from "react";
import { AccessibilityInfo, Platform, StyleSheet, Text } from "react-native";

import { bubbleShadow } from "@/theme";

import { Input, type InputHandle } from "../Input";

const field = () => screen.getByLabelText("Email");
const bubble = () => screen.getByTestId("email-bubble");

describe("Input", () => {
  it("forwards text changes", async () => {
    const onChangeText = jest.fn();
    await render(<Input label="Email" value="" onChangeText={onChangeText} />);

    await fireEvent.changeText(field(), "maria@example.com");

    expect(onChangeText).toHaveBeenCalledWith("maria@example.com");
  });

  it("shows error text and exposes it to screen readers", async () => {
    await render(
      <Input label="Email" value="x" onChangeText={jest.fn()} error="Enter a valid email" />,
    );

    expect(screen.getByText("Enter a valid email")).toBeTruthy();
    expect(screen.getByHintText("Enter a valid email")).toBe(field());
  });

  it("a prefix sits fixed before the field, outside its value", async () => {
    const onChangeText = jest.fn();
    await render(
      <Input
        label="Phone"
        value="(415) 555"
        onChangeText={onChangeText}
        prefix="+1"
        testID="phone"
      />,
    );

    expect(screen.getByTestId("phone-prefix")).toHaveTextContent("+1");
    expect(screen.getByLabelText("Phone").props.value).toBe("(415) 555");
    await fireEvent.changeText(screen.getByLabelText("Phone"), "(415) 5550");
    expect(onChangeText).toHaveBeenCalledWith("(415) 5550");
  });

  it("is not editable when disabled", async () => {
    const onChangeText = jest.fn();
    await render(<Input label="Email" value="" onChangeText={onChangeText} disabled />);

    await fireEvent.changeText(field(), "typed");

    expect(field().props.editable).toBe(false);
    expect(field().props.accessibilityState).toMatchObject({ disabled: true });
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it("focus shows the green ring and error shows the danger ring", async () => {
    const { rerender } = await render(
      <Input label="Email" value="" onChangeText={jest.fn()} testID="email" />,
    );
    expect(bubble().props.className).toContain("border-2 bg-white");
    expect(bubble().props.className).toContain("border-transparent");

    await fireEvent(field(), "focus");
    expect(bubble().props.className).toContain("border-green-700");

    await fireEvent(field(), "blur");
    expect(bubble().props.className).toContain("border-transparent");

    await rerender(
      <Input label="Email" value="x" onChangeText={jest.fn()} error="Required" testID="email" />,
    );
    expect(bubble().props.className).toContain("border-danger");
    expect(screen.getByText("Required").props.className).toContain("text-danger");
  });

  it("is a bubble: rounded, lifted by the shared shadow, no hairline", async () => {
    await render(
      <Input label="Email" value="" onChangeText={jest.fn()} hint="Work email" testID="email" />,
    );

    expect(bubble().props.className).toContain("rounded-md");
    expect(bubble().props.className.split(" ")).not.toContain("border");
    expect(StyleSheet.flatten(bubble().props.style)).toMatchObject({
      ...bubbleShadow,
      borderCurve: "continuous",
    });
    expect(screen.getByText("Work email").props.className).toContain("text-gray-500");
  });

  it("exposes the native field through ref and forwards the return key", async () => {
    const ref = createRef<InputHandle>();
    const onSubmitEditing = jest.fn();
    await render(
      <Input
        ref={ref}
        label="Email"
        value=""
        onChangeText={jest.fn()}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={onSubmitEditing}
      />,
    );

    expect(ref.current).not.toBeNull();
    expect(field().props.returnKeyType).toBe("next");
    expect(field().props.submitBehavior).toBe("submit");
    await fireEvent(field(), "submitEditing");
    expect(onSubmitEditing).toHaveBeenCalledTimes(1);
  });

  it("gives an accessory its own cell beside the field, so the text column never overlaps it", async () => {
    await render(
      <Input
        label="Email"
        value="a very long value that would run under a fixed pad"
        onChangeText={jest.fn()}
        accessory={<Text>Show</Text>}
        testID="email"
      />,
    );

    // A flex row: the field takes the remaining width, the accessory keeps its measured width.
    // No fixed right padding stands in for the accessory.
    const row = bubble();
    expect(row.props.className.split(" ")).toEqual(
      expect.arrayContaining(["flex-row", "items-center"]),
    );
    expect(field().props.className.split(" ")).toContain("flex-1");
    expect(field().props.className).not.toMatch(/pr-/);
    expect(row.children.indexOf(field())).toBe(0);
    expect(row.children).toHaveLength(2);
    expect(screen.getByText("Show")).toBeTruthy();
  });

  it("multiline: a tall field whose text starts at the top", async () => {
    await render(
      <Input label="Email" value="" onChangeText={jest.fn()} multiline testID="email" />,
    );

    expect(field().props.multiline).toBe(true);
    expect(field().props.textAlignVertical).toBe("top");
    expect(field().props.className).toContain("min-h-32");
    expect(bubble().props.className).toContain("items-start");
  });

  it("a single-line field stays centered in its bubble", async () => {
    await render(<Input label="Email" value="" onChangeText={jest.fn()} testID="email" />);

    expect(field().props.multiline).toBe(false);
    expect(field().props.textAlignVertical).toBeUndefined();
    expect(bubble().props.className).toContain("items-center");
  });

  it("shows the counter at the end of the message line, read politely, beside the hint", async () => {
    await render(
      <Input
        label="Email"
        value="x"
        onChangeText={jest.fn()}
        hint="Optional"
        counter="1,850 / 2,000"
        maxLength={2000}
        testID="email"
      />,
    );

    const counter = screen.getByTestId("email-counter");
    expect(counter).toHaveTextContent("1,850 / 2,000");
    expect(counter.props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(field().props.maxLength).toBe(2000);
  });

  describe("counter announcements", () => {
    const MAX = 10;
    let announce: jest.SpyInstance;

    beforeEach(() => {
      announce = jest
        .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
        .mockImplementation();
    });

    afterEach(() => announce.mockRestore());

    // The field as a screen drives it: the counter shows from 9 characters (90% of the limit).
    const typed = (value: string) => (
      <Input
        label="Email"
        value={value}
        onChangeText={jest.fn()}
        maxLength={MAX}
        counter={value.length >= 9 ? `${value.length} / ${MAX}` : undefined}
        testID="email"
      />
    );

    it("iOS: at the threshold and at the limit, not per keystroke or on a same-text render", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const { rerender } = await render(typed("abcdefg"));
      await fireEvent(field(), "focus");

      await rerender(typed("abcdefgh")); // 8: no counter yet
      expect(announce).not.toHaveBeenCalled();

      await rerender(typed("abcdefghi")); // 9: the counter appears
      expect(announce).toHaveBeenCalledTimes(1);
      expect(announce).toHaveBeenLastCalledWith("9 / 10", { queue: true });

      await rerender(typed("abcdefghi")); // unchanged
      expect(announce).toHaveBeenCalledTimes(1);

      await rerender(typed("abcdefghij")); // 10: the limit
      expect(announce).toHaveBeenCalledTimes(2);
      expect(announce).toHaveBeenLastCalledWith("10 / 10", { queue: true });

      await rerender(typed("abcdefghi")); // back under it, still showing: quiet
      await rerender(typed("abcdefgh")); // the counter goes away: quiet
      expect(announce).toHaveBeenCalledTimes(2);
    });

    it("iOS: a counter already showing when the field takes focus stays quiet", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      await render(typed("abcdefghij"));
      await fireEvent(field(), "focus");

      expect(announce).not.toHaveBeenCalled();
    });

    it("Android: the live region reads it, so nothing is announced twice", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      const { rerender } = await render(typed("abcdefgh"));
      await fireEvent(field(), "focus");
      await rerender(typed("abcdefghi"));
      await rerender(typed("abcdefghij"));

      expect(announce).not.toHaveBeenCalled();
      expect(screen.getByTestId("email-counter").props.accessibilityLiveRegion).toBe("polite");
    });
  });

  it("calls onBlur and still drops the focus ring", async () => {
    const onBlur = jest.fn();
    await render(
      <Input label="Email" value="" onChangeText={jest.fn()} onBlur={onBlur} testID="email" />,
    );

    await fireEvent(field(), "focus");
    expect(bubble().props.className).toContain("border-green-700");
    await fireEvent(field(), "blur");

    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(bubble().props.className).toContain("border-transparent");
  });
});
