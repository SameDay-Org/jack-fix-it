import "@/i18n";

import { act, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import { apiGet, useSession } from "@/api";
import { phoneFlowStore, withdrawPhoneStepOffer } from "@/features/phone/phoneFlow";

import { CustomerHomeScreen } from "../CustomerHomeScreen";
import { CATEGORIES, renderWithQuery, signedIn } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(),
  apiGet: jest.fn(),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), dismissTo: jest.fn() },
  useIsFocused: () => true,
  useScrollToTop: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const headline = () => screen.queryByRole("header", { name: "What's going on at home?" });

describe("useOpenPhoneStepAfterSignUp on the customer home", () => {
  beforeEach(() => {
    jest.mocked(useSession).mockReturnValue(signedIn());
    jest.mocked(apiGet).mockResolvedValue(CATEGORIES);
    jest.mocked(router.push).mockClear();
    phoneFlowStore.setState({ offeredAfterSignUp: false });
  });

  it("opens the phone step once after a sign-up", async () => {
    phoneFlowStore.setState({ offeredAfterSignUp: true });

    const { rerender } = await renderWithQuery(<CustomerHomeScreen />);
    await rerender(<CustomerHomeScreen />);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/verify-phone?from=sign-up");
    expect(headline()).toBeNull(); // nothing shows through the push
  });

  it("does not open it on a later sign-in", async () => {
    await renderWithQuery(<CustomerHomeScreen />);

    expect(router.push).not.toHaveBeenCalled();
    expect(headline()).toBeTruthy();
  });

  it("the customer home is under the step", async () => {
    phoneFlowStore.setState({ offeredAfterSignUp: true });
    await renderWithQuery(<CustomerHomeScreen />);

    // "Skip for now" (or a verified number) withdraws the offer, then pops back to home.
    await act(() => withdrawPhoneStepOffer());

    expect(headline()).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Painting" })).toBeTruthy(); // a category card
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});
