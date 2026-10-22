import { fireEvent, render, screen } from "@testing-library/react-native";

import { CodeInput } from "../CodeInput";

const field = () => screen.getByLabelText("Verification code");

describe("CodeInput", () => {
  it("one cell per digit, drawing what the field holds", async () => {
    await render(
      <CodeInput
        label="Verification code"
        value="12"
        onChangeText={jest.fn()}
        length={6}
        testID="code"
      />,
    );

    const cells = Array.from({ length: 6 }, (_, index) =>
      screen.getByTestId(`code-cell-${index}`, { includeHiddenElements: true }),
    );
    expect(cells.map((cell) => cell.children.length > 0)).toHaveLength(6);
    expect(screen.getByText("1", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText("2", { includeHiddenElements: true })).toBeTruthy();
    // The reader gets the field, not six separate cells.
    expect(screen.queryByText("1")).toBeNull();
  });

  it("is one native field with the system's one-time code autofill", async () => {
    await render(
      <CodeInput label="Verification code" value="" onChangeText={jest.fn()} length={6} />,
    );

    expect(field().props).toMatchObject({
      textContentType: "oneTimeCode",
      autoComplete: "sms-otp",
      importantForAutofill: "yes",
      keyboardType: "number-pad",
      inputMode: "numeric",
      maxLength: 6,
    });
  });

  it("keeps digits only, up to the length (a pasted or autofilled message included)", async () => {
    const onChangeText = jest.fn();
    await render(
      <CodeInput label="Verification code" value="" onChangeText={onChangeText} length={6} />,
    );

    await fireEvent.changeText(field(), "Your code: 123-4567");

    expect(onChangeText).toHaveBeenLastCalledWith("123456");
  });

  it("an error is shown under the cells, announced politely and given as the field's hint", async () => {
    await render(
      <CodeInput
        label="Verification code"
        value="123456"
        onChangeText={jest.fn()}
        length={6}
        error="That code isn't right."
        testID="code"
      />,
    );

    const message = screen.getByText("That code isn't right.");
    expect(message.props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByHintText("That code isn't right.")).toBe(field());
    expect(
      screen.getByTestId("code-cell-0", { includeHiddenElements: true }).props.className,
    ).toContain("border-danger");
  });

  it("is not editable when disabled", async () => {
    await render(
      <CodeInput label="Verification code" value="" onChangeText={jest.fn()} length={6} disabled />,
    );
    expect(field().props.editable).toBe(false);
    expect(field().props.accessibilityState).toMatchObject({ disabled: true });
  });
});
