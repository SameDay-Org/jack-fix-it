import "@/i18n";

import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LocalCleanupError, logout, useSession } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { METRICS } from "../../auth/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import { AccountScreen } from "../AccountScreen";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true, replace: jest.fn() },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const renderAccount = () =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AccountScreen />
    </SafeAreaProvider>,
  );

describe("AccountScreen", () => {
  beforeEach(() => {
    jest.mocked(logout).mockReset();
    jest.mocked(router.push).mockClear();
  });

  it("shows name, email, role and verified phone", async () => {
    jest.mocked(useSession).mockReturnValue(
      signedIn({
        first_name: "Maria",
        last_name: "Lopez",
        phone: "+14155550123",
        phone_verified: true,
      }),
    );

    await renderAccount();

    expect(screen.getByRole("header", { name: "Account" })).toBeTruthy();
    expect(screen.getByTestId("account-identity")).toHaveTextContent(
      "MLMaria Lopezmaria@example.com",
    );
    expect(screen.getByTestId("account-role")).toHaveTextContent("Customer");
    expect(screen.getByTestId("account-phone")).toHaveTextContent("Phone+1 (415) 555-0123Verified");
    expect(screen.queryByRole("button", { name: "Verify your phone" })).toBeNull();
  });

  it("shows the email alone for an account without a name", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));

    await renderAccount();

    expect(screen.getByTestId("account-identity")).toHaveTextContent("Mmaria@example.com");
    expect(screen.getByTestId("account-role")).toHaveTextContent("Pro");
  });

  it("offers verify phone when unverified", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn());

    await renderAccount();

    expect(screen.queryByTestId("account-phone")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Verify your phone" }));
    expect(router.push).toHaveBeenCalledWith("/verify-phone");
  });

  it("back returns to the previous screen", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn());

    await renderAccount();
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));

    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("log out shows loading and signs out", async () => {
    const pending = deferred<void>();
    jest.mocked(logout).mockReturnValue(pending.promise);
    jest.mocked(useSession).mockReturnValue(signedIn());

    await renderAccount();
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));

    expect(logout).toHaveBeenCalledTimes(1);
    expect(
      (await screen.findByRole("button", { name: "Log out, Loading" })).props.accessibilityState,
    ).toMatchObject({ busy: true });
    pending.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy());
  });

  it("a failed local delete is handled: the screen neither throws nor stays loading", async () => {
    jest.mocked(logout).mockRejectedValue(new LocalCleanupError());
    jest.mocked(useSession).mockReturnValue(signedIn());

    await renderAccount();
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));

    // The session is already signed out (the gate leaves for welcome, which shows the notice);
    // this screen neither breaks nor shows its own error.
    await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy());
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
