import i18n from "@/i18n";

import { act, fireEvent, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import { ApiError, apiGet } from "@/api";

import { ProProfileScreen } from "../../quotes/ProProfileScreen";
import type { ProPublicProfile } from "../../quotes/useProProfile";
import { quotesQueryKey, type CustomerQuote } from "../../quotes/useRequestQuotes";
import {
  freezeClock,
  navigation,
  newQueryClient,
  QUOTES,
  renderWithQuery,
  REQUEST_ID,
} from "../../quotes/__tests__/helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  apiPost: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("../../quotes/__tests__/helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const [, MARIA] = QUOTES;
const PROFILE: ProPublicProfile = {
  id: MARIA.pro.id,
  name: "María P.",
  rating_avg: "4.80",
  jobs_count: 23,
  years_of_experience: 8,
  verified: true,
  bio: null,
  categories: [],
  member_since: "2024-03-01",
};
const accepted = (item: CustomerQuote): CustomerQuote => ({ ...item, status: "accepted" });

/** The profile over a cache holding the request's quotes (`null` for none), with these params. */
async function renderProfile(params: Record<string, string>, items: CustomerQuote[] | null = null) {
  navigation.setParams(params);
  const client = newQueryClient();
  if (items) client.setQueryData(quotesQueryKey(REQUEST_ID), { items });
  await renderWithQuery(<ProProfileScreen />, client);
}

beforeEach(() => {
  freezeClock();
  navigation.reset();
  jest.mocked(apiGet).mockReset().mockResolvedValue(PROFILE);
  jest.mocked(router.back).mockClear();
});

afterEach(async () => {
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("the pro's profile opened from the ongoing job (#64)", () => {
  it.each([
    ["with no list cached", null],
    ["over the list with the quote accepted", [accepted(MARIA)]],
  ])("the bottom button says Back to your job (%s)", async (_, items) => {
    await renderProfile({ id: REQUEST_ID, quoteId: MARIA.id, from: "job" }, items);

    expect(await screen.findByRole("header", { name: "María P., verified" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to your job" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to quotes" })).toBeNull();
    expect(screen.queryByTestId("pro-profile-accept")).toBeNull();

    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: "Back to your job" })),
    );
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("without from, the bottom button still says Back to quotes", async () => {
    await renderProfile({ id: REQUEST_ID, quoteId: MARIA.id }, QUOTES);

    expect(await screen.findByRole("header", { name: "María P., verified" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to quotes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to your job" })).toBeNull();
  });

  it("a gone quote opened from the job offers the way back to the job", async () => {
    jest.mocked(apiGet).mockRejectedValue(new ApiError(404, "not_found"));
    await renderProfile({ id: REQUEST_ID, quoteId: MARIA.id, from: "job" });

    expect(
      await screen.findByRole("header", { name: "This quote is no longer available" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to quotes" })).toBeNull();

    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: "Back to your job" })),
    );
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("in Spanish, the way back names the job too", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderProfile({ id: REQUEST_ID, quoteId: MARIA.id, from: "job" });

    await screen.findByTestId("pro-profile-bar");
    expect(screen.getByRole("button", { name: "Volver a tu trabajo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ver presupuestos" })).toBeNull();
  });
});
