import i18n from "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { router } from "expo-router";

import { useSession } from "@/api";

import { user } from "../../../api/__tests__/helpers";
import { renderInSafeArea, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { HistoryScreen } from "../HistoryScreen";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  useSession: jest.fn(),
}));
jest.mock("expo-router", () => ({
  router: { navigate: jest.fn() },
  useIsFocused: () => true,
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
const signedInAs = (role: "customer" | "pro" | "agent") =>
  jest.mocked(useSession).mockReturnValue({
    ...SESSION_SIGNED_OUT,
    status: "signedIn",
    user: { ...user, role },
  });

describe("HistoryScreen (the empty state until #47)", () => {
  afterEach(async () => {
    jest.clearAllMocks();
    await act(() => i18n.changeLanguage("en"));
  });

  it("customer: the title, the empty state and the way to Home, as one screen (no card)", async () => {
    signedInAs("customer");
    await renderInSafeArea(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Your requests" })).toBeTruthy();
    expect(screen.getByText("Requests you send will show up here.")).toBeTruthy();
    // The whole screen, not a card: no raised white bubble (the kit's Card shadow) in the tree.
    const shadowed = screen
      .getByTestId("history-screen")
      .queryAll((node) => StyleSheet.flatten(node.props.style)?.shadowRadius !== undefined);
    expect(shadowed).toEqual([]);
    await fireEvent.press(screen.getByRole("button", { name: "Browse categories" }));
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it("pro: the jobs copy and the way to Home", async () => {
    signedInAs("pro");
    await renderInSafeArea(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Your jobs" })).toBeTruthy();
    expect(screen.getByText("Jobs you're hired for will show up here.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Go to Home" }));
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it("staff read the pro copy", async () => {
    signedInAs("agent");
    await renderInSafeArea(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Your jobs" })).toBeTruthy();
  });

  it("Spanish", async () => {
    signedInAs("customer");
    await act(() => i18n.changeLanguage("es"));
    await renderInSafeArea(<HistoryScreen />);

    expect(screen.getByRole("header", { name: "Tus solicitudes" })).toBeTruthy();
    expect(screen.getByText("Las solicitudes que envíes aparecerán aquí.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ver categorías" })).toBeTruthy();
  });

  it("renders nothing without a user", async () => {
    jest.mocked(useSession).mockReturnValue(SESSION_SIGNED_OUT);
    await renderInSafeArea(<HistoryScreen />);

    expect(screen.queryByTestId("history-screen")).toBeNull();
  });
});
