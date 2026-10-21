import { fireEvent, render, screen } from "@testing-library/react-native";
import { createRef } from "react";
import { StyleSheet, Text } from "react-native";

import { bubbleShadow } from "@/theme";

import { Input, type InputHandle } from "../Input";

const field = () => screen.getByLabelText("Email");

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

  it("is not editable when disabled", async () => {
    const onChangeText = jest.fn();
    await render(<Input label="Email" value="" onChangeText={onChangeText} disabled />);

    await fireEvent.changeText(field(), "typed");

    expect(field().props.editable).toBe(false);
    expect(field().props.accessibilityState).toMatchObject({ disabled: true });
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it("focus shows the green ring and error shows the danger ring", async () => {
    const { rerender } = await render(<Input label="Email" value="" onChangeText={jest.fn()} />);
    expect(field().props.className).toContain("border-2 bg-white");
    expect(field().props.className).toContain("border-transparent");

    await fireEvent(field(), "focus");
    expect(field().props.className).toContain("border-green-700");

    await fireEvent(field(), "blur");
    expect(field().props.className).toContain("border-transparent");

    await rerender(<Input label="Email" value="x" onChangeText={jest.fn()} error="Required" />);
    expect(field().props.className).toContain("border-danger");
    expect(screen.getByText("Required").props.className).toContain("text-danger");
  });

  it("is a bubble: rounded, lifted by the shared shadow, no hairline", async () => {
    await render(<Input label="Email" value="" onChangeText={jest.fn()} hint="Work email" />);

    expect(field().props.className).toContain("rounded-md");
    expect(field().props.className.split(" ")).not.toContain("border");
    expect(StyleSheet.flatten(field().props.style)).toMatchObject({
      ...bubbleShadow,
      borderCurve: "continuous",
    });
    expect(screen.getByText("Work email").props.className).toContain("text-gray-500");
  });

  it("exposes the native field through ref, forwards the return key, and makes room for an accessory", async () => {
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
        accessory={<Text>Show</Text>}
      />,
    );

    expect(ref.current).not.toBeNull();
    expect(field().props.returnKeyType).toBe("next");
    expect(field().props.submitBehavior).toBe("submit");
    await fireEvent(field(), "submitEditing");
    expect(onSubmitEditing).toHaveBeenCalledTimes(1);
    expect(field().props.className).toContain("pr-14");
    expect(screen.getByText("Show")).toBeTruthy();
  });
});
