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
    });
  });

  it("a paste keeps its digits: separators and a whole SMS give the code (no native maxLength trims it first)", async () => {
    const onChangeText = jest.fn();
    await render(
      <CodeInput label="Verification code" value="" onChangeText={onChangeText} length={6} />,
    );
    expect(field().props.maxLength).toBeUndefined();

    await fireEvent.changeText(field(), "123-456");
    expect(onChangeText).toHaveBeenLastCalledWith("123456");
    await fireEvent.changeText(field(), "Your Jack Fix It code is 123456");
    expect(onChangeText).toHaveBeenLastCalledWith("123456");
  });

  it("an autofill over a half-typed code replaces it; a keystroke past the last cell is ignored", async () => {
    const onChangeText = jest.fn();
    const { rerender } = await render(
      <CodeInput label="Verification code" value="12" onChangeText={onChangeText} length={6} />,
    );
    await fireEvent.changeText(field(), "12654321");
    expect(onChangeText).toHaveBeenLastCalledWith("654321");

    onChangeText.mockClear();
    await rerender(
      <CodeInput label="Verification code" value="123456" onChangeText={onChangeText} length={6} />,
    );
    await fireEvent.changeText(screen.getByLabelText("Verification code"), "1234567");
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it("the caret stays after the last digit, whichever cell is tapped", async () => {
    await render(
      <CodeInput label="Verification code" value="123" onChangeText={jest.fn()} length={6} />,
    );
    expect(field().props.selection).toEqual({ start: 3, end: 3 });
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
