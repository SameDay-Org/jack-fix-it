import "@/i18n";

import { fireEvent, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import { ApiError, login } from "@/api";

import { LoginScreen } from "../LoginScreen";
import { renderInSafeArea } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("@/api", () => ({ ...jest.requireActual("@/api"), login: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

async function fillAndSubmit(address: string, secret: string) {
  await fireEvent.changeText(screen.getByLabelText("Email"), address);
  await fireEvent.changeText(screen.getByLabelText("Password"), secret);
  await fireEvent.press(screen.getByRole("button", { name: "Log in" }));
}

describe("LoginScreen", () => {
  beforeEach(() => {
    jest.mocked(login).mockReset();
    jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  });

  it.each([
    [401, "invalid_credentials", "Email or password is incorrect."],
    [403, "account_suspended", "This account is suspended. Contact support."],
    [429, "rate_limited", "Too many attempts. Try again in a moment."],
  ])("maps %s %s to its message", async (status, code, message) => {
    jest.mocked(login).mockRejectedValue(new ApiError(status, code));
    await renderInSafeArea(<LoginScreen />);

    await fillAndSubmit("maria@example.com", "correct horse battery");

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(message);
  });

  it("submits the normalized email with the current-password autofill intent and no reset link", async () => {
    jest.mocked(login).mockResolvedValue(undefined);
    await renderInSafeArea(<LoginScreen />);

    expect(screen.getByLabelText("Password").props.textContentType).toBe("password");
    expect(screen.getByLabelText("Password").props.autoComplete).toBe("current-password");
    expect(screen.queryByText(/forgot/i)).toBeNull();

    await fillAndSubmit("Maria@Example.com", "correct horse battery");

    expect(login).toHaveBeenCalledWith({
      email: "maria@example.com",
      password: "correct horse battery",
    });
  });
});
