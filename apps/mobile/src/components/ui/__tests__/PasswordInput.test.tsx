import "@/i18n";

import { fireEvent, render, screen } from "@testing-library/react-native";

import { PasswordInput } from "../PasswordInput";

const field = () => screen.getByLabelText("Password");

describe("PasswordInput", () => {
  it("hides the text until Show is pressed, with an accessible toggle inside the field", async () => {
    await render(
      <PasswordInput label="Password" value="correct horse" onChangeText={jest.fn()} testID="pw" />,
    );

    expect(field().props.secureTextEntry).toBe(true);
    expect(field().props.autoCapitalize).toBe("none");
    expect(field().props.autoCorrect).toBe(false);
    expect(screen.getByTestId("pw-bubble").children).toHaveLength(2);
    expect(screen.getByText("Show")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Show password" }));

    expect(field().props.secureTextEntry).toBe(false);
    expect(screen.getByRole("button", { name: "Hide password" })).toBeTruthy();
    expect(screen.getByText("Hide")).toBeTruthy();
  });

  it("the toggle is disabled with the field", async () => {
    await render(<PasswordInput label="Password" value="" onChangeText={jest.fn()} disabled />);

    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(toggle);
    expect(field().props.secureTextEntry).toBe(true);
  });
});
