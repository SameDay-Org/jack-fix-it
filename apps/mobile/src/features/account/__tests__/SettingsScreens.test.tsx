import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import type { ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useSession } from "@/api";
import i18n from "@/i18n";

import { METRICS } from "../../auth/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import { HelpScreen, LegalScreen } from "../InfoScreens";
import { refreshPermission, resetPermissionForTests } from "../../notifications/permission";
import { SettingsScreen } from "../SettingsScreen";

jest.mock("@/api", () => ({ useSession: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("expo-notifications");
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

// Settings saves the language through a mutation (#218), so it renders under a Query cache.
const renderScreen = (ui: ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
    </SafeAreaProvider>,
  );

beforeEach(() => {
  jest.mocked(router.push).mockClear();
  jest.mocked(router.back).mockClear();
  jest.mocked(router.replace).mockClear();
  jest.mocked(router.canGoBack).mockReturnValue(true);
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("SettingsScreen", () => {
  it("lists the email and the verified phone, to their owner", async () => {
    jest
      .mocked(useSession)
      .mockReturnValue(signedIn({ phone: "+14155550123", phone_verified: true }));

    await renderScreen(<SettingsScreen />);

    expect(screen.getByRole("header", { name: "Settings" })).toBeOnTheScreen();
    expect(screen.getByTestId("settings-email")).toHaveTextContent("Emailmaria@example.com");
    expect(screen.getByTestId("settings-phone")).toHaveTextContent(
      "Phone+1 (415) 555-0123Verified",
    );
    expect(screen.queryByRole("button", { name: /Verify your phone/ })).toBeNull();
  });

  it("says whether notifications are on, under its own heading (#334)", async () => {
    resetPermissionForTests();
    jest.mocked(useSession).mockReturnValue(signedIn());
    await act(async () => {
      await refreshPermission();
    });

    await renderScreen(<SettingsScreen />);

    // The section's heading, then the row's label.
    expect(screen.getAllByText("Notifications", { exact: true })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Notifications, Off" })).toBeOnTheScreen();
  });

  it("offers to verify an unverified phone", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn());

    await renderScreen(<SettingsScreen />);
    await fireEvent.press(
      screen.getByRole("button", { name: "Verify your phone, Not verified yet" }),
    );

    expect(router.push).toHaveBeenCalledWith("/verify-phone");
  });

  it("goes back, or to Account when opened with nothing behind it", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn());
    await renderScreen(<SettingsScreen />);

    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);

    jest.mocked(router.canGoBack).mockReturnValue(false);
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(router.replace).toHaveBeenCalledWith("/account");
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    jest.mocked(useSession).mockReturnValue(signedIn());

    await renderScreen(<SettingsScreen />);

    expect(screen.getByRole("header", { name: "Configuración" })).toBeOnTheScreen();
    expect(screen.getByTestId("settings-email")).toHaveTextContent("Correomaria@example.com");
    expect(
      screen.getByRole("button", { name: "Verifica tu teléfono, Aún no verificado" }),
    ).toBeOnTheScreen();
  });
});

describe.each([
  ["Help", () => <HelpScreen />, "Support when you need it", "Apoyo cuando lo necesites"],
  ["Legal", () => <LegalScreen />, "Legal", "Legal"],
])("%sScreen", (_, screenOf, title, titleEs) => {
  it("says plainly that its content is not ready, with nothing to press but Back", async () => {
    await renderScreen(screenOf());

    expect(screen.getByRole("header", { name: title })).toBeOnTheScreen();
    expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      "Back",
    ]);
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");

    await renderScreen(screenOf());

    expect(screen.getByRole("header", { name: titleEs })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Atrás" })).toBeOnTheScreen();
  });
});
