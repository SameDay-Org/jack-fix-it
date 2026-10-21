import "@/i18n";

import { fireEvent, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import { useSession } from "@/api";

import { WelcomeScreen } from "../WelcomeScreen";
import { renderInSafeArea, SIGNED_OUT } from "./helpers";

jest.mock("@/api", () => ({ useSession: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;

describe("WelcomeScreen", () => {
  beforeEach(() => {
    jest.mocked(useSession).mockReturnValue(SESSION_SIGNED_OUT);
    jest.mocked(router.push).mockClear();
  });

  it("hero copy: brand, tagline with one accent word, support line; two ways in and nothing else", async () => {
    await renderInSafeArea(<WelcomeScreen />);

    expect(screen.getByText("Jack Fix It")).toBeTruthy();
    expect(screen.getByTestId("welcome-tagline")).toHaveTextContent(
      "Whatever happens at home, we fix it.",
    );
    expect(screen.getByText("fix").props.className).toContain("text-green-500");
    expect(screen.getByText("Tell Jack. We'll take care of the rest.")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByText(/Tell Jack What Happened/i)).toBeNull();
    expect(screen.queryByTestId("welcome-partial-cleanup")).toBeNull();
  });

  it("Get started goes to the role choice and the account link to login", async () => {
    await renderInSafeArea(<WelcomeScreen />);

    await fireEvent.press(screen.getByRole("button", { name: "Get started" }));
    expect(router.push).toHaveBeenLastCalledWith("/(auth)/role");

    await fireEvent.press(screen.getByRole("button", { name: "I already have an account" }));
    expect(router.push).toHaveBeenLastCalledWith("/(auth)/login");
  });

  it("after a sign-out that could not clear the device, says so", async () => {
    jest.mocked(useSession).mockReturnValue({ ...SESSION_SIGNED_OUT, cleanupPending: true });

    await renderInSafeArea(<WelcomeScreen />);

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("Signed out. Some data couldn't be cleared from this device.");
  });

  it("pads the bottom inset under the white bubble itself", async () => {
    await renderInSafeArea(<WelcomeScreen />);

    expect(screen.getByTestId("welcome-actions").props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 16 })]),
    );
  });
});
