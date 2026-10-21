import "@/i18n";

import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import { LocalCleanupError, logout, useSession } from "@/api";

import { deferred, user } from "../../../api/__tests__/helpers";
import { HomePlaceholderScreen } from "../HomePlaceholderScreen";
import { renderInSafeArea, SIGNED_OUT } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
const signedInAs = (role: "customer" | "pro") =>
  jest.mocked(useSession).mockReturnValue({
    ...SESSION_SIGNED_OUT,
    status: "signedIn",
    user: { ...user, role },
  });

describe("HomePlaceholderScreen", () => {
  beforeEach(() => jest.mocked(logout).mockReset());

  it("shows the email, the role badge and logs out", async () => {
    const pending = deferred<void>();
    jest.mocked(logout).mockReturnValue(pending.promise);
    signedInAs("pro");

    await renderInSafeArea(<HomePlaceholderScreen />);

    expect(screen.getByTestId("home-welcome")).toHaveTextContent("Welcome, maria@example.com");
    expect(screen.getByText("maria@example.com").props.className).toContain("text-title-2");
    expect(screen.getByTestId("home-role")).toHaveTextContent("Pro");
    expect(screen.getByText("Your home screen is on its way.")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));

    expect(logout).toHaveBeenCalledTimes(1);
    expect(
      (await screen.findByRole("button", { name: "Log out, Loading" })).props.accessibilityState,
    ).toMatchObject({ busy: true });
    pending.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy());
  });

  it("a customer sees the customer badge", async () => {
    signedInAs("customer");

    await renderInSafeArea(<HomePlaceholderScreen />);

    expect(screen.getByTestId("home-role")).toHaveTextContent("Customer");
  });

  it("LocalCleanupError does not break the screen; the notice belongs to welcome", async () => {
    jest.mocked(logout).mockRejectedValue(new LocalCleanupError());
    signedInAs("pro");

    await renderInSafeArea(<HomePlaceholderScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
