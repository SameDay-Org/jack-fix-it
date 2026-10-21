import { fireEvent, render, screen } from "@testing-library/react-native";

import { Input } from "../Input";

describe("Input", () => {
  it("forwards text changes", async () => {
    const onChangeText = jest.fn();
    await render(<Input label="Email" value="" onChangeText={onChangeText} />);

    await fireEvent.changeText(screen.getByLabelText("Email"), "maria@example.com");

    expect(onChangeText).toHaveBeenCalledWith("maria@example.com");
  });

  it("shows error text and exposes it to screen readers", async () => {
    await render(
      <Input label="Email" value="x" onChangeText={jest.fn()} error="Enter a valid email" />,
    );

    expect(screen.getByText("Enter a valid email")).toBeTruthy();
    expect(screen.getByHintText("Enter a valid email")).toBe(screen.getByLabelText("Email"));
  });

  it("is not editable when disabled", async () => {
    const onChangeText = jest.fn();
    await render(<Input label="Email" value="" onChangeText={onChangeText} disabled />);
    const field = screen.getByLabelText("Email");

    await fireEvent.changeText(field, "typed");

    expect(field.props.editable).toBe(false);
    expect(field.props.accessibilityState).toMatchObject({ disabled: true });
    expect(onChangeText).not.toHaveBeenCalled();
  });
});
