import "@/i18n";

import { fireEvent, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import { RoleScreen } from "../RoleScreen";
import { renderInSafeArea } from "./helpers";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const customer = () => screen.getByRole("radio", { name: "I need help at home" });
const pro = () => screen.getByRole("radio", { name: "I'm a pro" });
const next = () => screen.getByRole("button", { name: "Continue" });

describe("RoleScreen", () => {
  beforeEach(() => jest.mocked(router.push).mockClear());

  it("continue is disabled until a role is chosen, then carries it to sign-up", async () => {
    await renderInSafeArea(<RoleScreen />);

    expect(next().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(next());
    expect(router.push).not.toHaveBeenCalled();

    await fireEvent.press(pro());
    expect(next().props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(next());

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(auth)/sign-up",
      params: { role: "pro" },
    });
  });

  it("radio semantics: a radiogroup with one checked card at a time", async () => {
    await renderInSafeArea(<RoleScreen />);

    expect(screen.getByTestId("role-options").props.accessibilityRole).toBe("radiogroup");
    expect(customer().props.accessibilityState).toMatchObject({ checked: false });
    expect(pro().props.accessibilityState).toMatchObject({ checked: false });

    await fireEvent.press(customer());
    expect(customer().props.accessibilityState).toMatchObject({ checked: true });
    expect(pro().props.accessibilityState).toMatchObject({ checked: false });

    await fireEvent.press(pro());
    expect(customer().props.accessibilityState).toMatchObject({ checked: false });
    expect(pro().props.accessibilityState).toMatchObject({ checked: true });
  });

  it("back returns to the previous step", async () => {
    await renderInSafeArea(<RoleScreen />);

    await fireEvent.press(screen.getByRole("button", { name: "Back" }));

    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
