import "@/i18n";

import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import { logout, restoreSession } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { OfflineScreen } from "../OfflineScreen";
import { renderInSafeArea } from "./helpers";

jest.mock("@/api", () => ({ logout: jest.fn(), restoreSession: jest.fn() }));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

describe("OfflineScreen", () => {
  it("try again re-runs restore and shows the button busy meanwhile", async () => {
    const pending = deferred<void>();
    jest.mocked(restoreSession).mockReturnValue(pending.promise);
    await renderInSafeArea(<OfflineScreen />);

    expect(screen.getByText("Can't reach Jack right now")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));

    expect(restoreSession).toHaveBeenCalledTimes(1);
    const busy = await screen.findByRole("button", { name: "Try again, Loading" });
    expect(busy.props.accessibilityState).toMatchObject({ busy: true });
    expect(
      screen.getByRole("button", { name: "Log in with another account" }).props.accessibilityState,
    ).toMatchObject({ disabled: true });

    pending.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
  });

  it("use another account logs out locally", async () => {
    jest.mocked(logout).mockResolvedValue(undefined);
    await renderInSafeArea(<OfflineScreen />);

    await fireEvent.press(screen.getByRole("button", { name: "Log in with another account" }));

    expect(logout).toHaveBeenCalledTimes(1);
  });
});
