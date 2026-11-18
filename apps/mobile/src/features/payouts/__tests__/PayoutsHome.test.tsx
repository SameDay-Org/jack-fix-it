import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { openAuthSessionAsync } from "expo-web-browser";

import { apiGet, apiPost, useSession } from "@/api";

import { settle } from "../../../api/__tests__/helpers";
import { page, summary } from "../../opportunities/__tests__/helpers";
import { ProHomeScreen } from "../../pro-home/ProHomeScreen";
import type { ProProfile } from "../../pro-profile";
import { FULL_PROFILE } from "../../pro-profile/__tests__/helpers";
import type { Payouts } from "../api";
import { PayoutsScreen } from "../PayoutsScreen";

import {
  link,
  LINK_MARK,
  navigation,
  newQueryClient,
  PAYOUTS,
  payouts,
  PROFILE,
  renderWithQuery,
  RETURN_LINK,
  signedIn,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => {
  const { routerMock, navigation: nav } =
    jest.requireActual<typeof import("./helpers")>("./helpers");
  const own = { setParams: () => nav.setParams({}) };
  return { ...routerMock, useNavigation: () => own };
});
// "Your jobs" (#63) and the notifications pre-prompt (#334) have their own suites; left out here.
jest.mock("@/features/pro-jobs", () => ({
  YourJobs: () => null,
  useProJobs: () => ({ refetch: () => Promise.resolve() }),
}));
jest.mock("@/features/notifications/NotificationsPrompt", () => ({
  NotificationsPrompt: () => null,
}));
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

const OPPORTUNITIES = "/v1/pros/me/opportunities";
const APPROVED: ProProfile = { ...FULL_PROFILE, verification_status: "approved" };
const REQUEST = summary(1);

/** The pro as the API holds it: Stripe's answer is stored on the profile by the status call. */
let stripe: Payouts;
let stored: ProProfile;
let client: QueryClient;

const flush = () => act(async () => settle());
const paths = () => jest.mocked(apiGet).mock.calls.map(([path]) => path as string);

/** The home under the payout screen, as the stack keeps them: one cache for both. */
async function openBoth() {
  await renderWithQuery(
    <>
      <ProHomeScreen />
      <PayoutsScreen />
    </>,
    client,
  );
  await flush();
}

/** The pro goes through Stripe's page, whose return page sends the browser back to the app. */
async function setUpPayouts(after: Payouts) {
  jest.mocked(openAuthSessionAsync).mockImplementationOnce(async () => {
    stripe = after;
    return { type: "success", url: RETURN_LINK };
  });
  await act(async () => fireEvent.press(screen.getByTestId("payouts-setup")));
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
  navigation.setParams({});
  client = newQueryClient();
  stripe = payouts("not_started");
  stored = APPROVED;
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));
  jest.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path === OPPORTUNITIES) return page([REQUEST]);
    if (path === PAYOUTS) {
      // GET /v1/pros/me/payouts keeps the profile's payouts_enabled current.
      stored = { ...stored, payouts_enabled: stripe.payouts_enabled };
      return stripe;
    }
    if (path === PROFILE) return stored;
    throw new Error(`not asked for here: ${path}`);
  }) as unknown as typeof apiGet);
  jest.mocked(apiPost).mockImplementation((async () => link()) as unknown as typeof apiPost);
});

afterEach(async () => {
  await flush();
});

describe("payout setup opens the pro's home (#277)", () => {
  it("back from Stripe with payouts on, the home lists the requests", async () => {
    await openBoth();

    // Approved, payouts off: the home shows what is left and asks for no request.
    expect(screen.getByTestId("payout-setup")).toBeTruthy();
    expect(screen.queryByTestId(`opportunity-${REQUEST.dispatch_id}`)).toBeNull();
    expect(paths()).not.toContain(OPPORTUNITIES);

    await setUpPayouts(payouts("enabled"));

    expect(screen.getByTestId("payouts-status")).toHaveTextContent("On");
    expect(await screen.findByTestId(`opportunity-${REQUEST.dispatch_id}`)).toBeTruthy();
    expect(screen.queryByTestId("payout-setup")).toBeNull();
    expect(screen.queryByTestId("pro-onboarding")).toBeNull();
    const cached = client
      .getQueryCache()
      .getAll()
      .map((query) => query.state);
    expect(JSON.stringify(cached)).not.toContain(LINK_MARK);
  });

  it("back from Stripe with more to do, the home stays as it was", async () => {
    await openBoth();

    await setUpPayouts(payouts("incomplete"));

    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In progress");
    expect(screen.getByTestId("payout-setup")).toBeTruthy();
    expect(paths()).not.toContain(OPPORTUNITIES);
  });
});
