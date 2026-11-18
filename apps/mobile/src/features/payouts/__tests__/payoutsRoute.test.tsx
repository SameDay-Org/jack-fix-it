import "@/i18n";

import { act, screen } from "@testing-library/react-native";

import { apiGet, apiPost, useSession } from "@/api";

import { settle } from "../../../api/__tests__/helpers";
// The route's own files: the layout that guards `/pro/...` and the screen it guards here.
import ProLayout from "../../../app/(app)/pro/_layout";

import { navigation, PAYOUTS, payouts, renderWithQuery, signedIn } from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
// Where a redirect sends the screen; it draws nothing.
const mockRedirect = jest.fn((_props: { href: string }) => null);
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  const { routerMock } = jest.requireActual<typeof import("./helpers")>("./helpers");
  const own = { setParams: () => undefined };
  return {
    ...routerMock,
    useNavigation: () => own,
    Redirect: (props: { href: string }) => mockRedirect(props),
    // The layout's stack, showing the one route under test: `/pro/payouts`.
    Stack: () =>
      createElement(
        jest.requireActual<typeof import("../../../app/(app)/pro/payouts")>(
          "../../../app/(app)/pro/payouts",
        ).default,
      ),
  };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// Reduce Motion on: the loading skeleton's endless pulse would otherwise keep the run busy.
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));

const flush = () => act(async () => settle());

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
  navigation.setParams({});
  jest.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path === PAYOUTS) return payouts("not_started");
    throw new Error("not asked for here");
  }) as unknown as typeof apiGet);
});

afterEach(async () => {
  await flush();
});

describe("/pro/payouts is a pro's route (#277)", () => {
  it("builds the payout screen for a pro", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
    await renderWithQuery(<ProLayout />);
    await flush();

    expect(screen.getByTestId("payouts-screen")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up payouts" })).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it.each(["customer", "admin"] as const)(
    "sends a signed-in %s home, a return link included: nothing is built or asked",
    async (role) => {
      // As `jackfixit://payouts?result=return` lands: `/pro/payouts?result=return`.
      navigation.setParams({ result: "return" });
      jest.mocked(useSession).mockReturnValue(signedIn({ role }));
      await renderWithQuery(<ProLayout />);
      await flush();

      expect(mockRedirect).toHaveBeenCalledWith({ href: "/" });
      expect(screen.queryByTestId("payouts-screen")).toBeNull();
      expect(apiGet).not.toHaveBeenCalled();
      expect(apiPost).not.toHaveBeenCalled();
    },
  );
});
