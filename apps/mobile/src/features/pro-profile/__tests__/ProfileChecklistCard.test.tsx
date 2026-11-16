import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { Text } from "react-native";

import { ApiError, apiGet, useSession } from "@/api";

import { myProProfileQueryKey } from "../api";
import { ProfileChecklistCard } from "../ProfileChecklistCard";
import { ProOnly } from "../ProOnly";
import {
  EMPTY_PROFILE,
  FULL_PROFILE,
  navigation,
  newQueryClient,
  renderWithQuery,
  signedIn,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
// Where a redirect sends the screen; it draws nothing.
const mockRedirect = jest.fn((_props: { href: string }) => null);
jest.mock("expo-router", () => ({
  ...jest.requireActual("./helpers").routerMock,
  Redirect: (props: { href: string }) => mockRedirect(props),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const PROFILE = "/v1/pros/me";
const stepLabel = (step: string) =>
  screen.getByTestId(`profile-checklist-${step}`).props.accessibilityLabel as string;

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockResolvedValue(EMPTY_PROFILE);
});

describe("ProfileChecklistCard", () => {
  it("lists what a new profile still misses and opens the form", async () => {
    await renderWithQuery(<ProfileChecklistCard />);

    expect(await screen.findByText("Finish your profile")).toBeTruthy();
    expect(screen.getByTestId("profile-checklist-progress")).toHaveTextContent("0 of 4 done");
    expect(stepLabel("photo")).toBe("Profile photo: to do");
    expect(stepLabel("about")).toBe("About you: to do");
    expect(stepLabel("categories")).toBe("Categories: to do");
    expect(stepLabel("areas")).toBe("Service areas: to do");
    expect(apiGet).toHaveBeenCalledWith(
      PROFILE,
      expect.objectContaining({ auth: true, generation: 1 }),
    );

    await fireEvent.press(screen.getByRole("button", { name: "Complete profile" }));
    expect(router.push).toHaveBeenCalledWith("/pro/profile");
  });

  it("ticks the parts already filled in", async () => {
    jest.mocked(apiGet).mockResolvedValue({ ...FULL_PROFILE, bio: null, service_areas: [] });
    await renderWithQuery(<ProfileChecklistCard />);

    expect(await screen.findByText("2 of 4 done")).toBeTruthy();
    expect(stepLabel("photo")).toBe("Profile photo: done");
    expect(stepLabel("about")).toBe("About you: to do");
    expect(stepLabel("categories")).toBe("Categories: done");
    expect(stepLabel("areas")).toBe("Service areas: to do");
  });

  it("is gone once the profile is complete", async () => {
    // Shown first, so the card leaving is the complete profile's doing, not a slow answer's.
    const client = newQueryClient();
    await renderWithQuery(<ProfileChecklistCard />, client);
    expect(await screen.findByTestId("profile-checklist")).toBeTruthy();

    await act(async () => client.setQueryData(myProProfileQueryKey(1), FULL_PROFILE));
    await waitFor(() => expect(screen.queryByTestId("profile-checklist")).toBeNull());
  });

  it.each([
    ["while the profile loads", () => new Promise<never>(() => undefined)],
    ["when the profile did not load", () => Promise.reject(new ApiError(500, undefined))],
  ])("draws nothing %s", async (_case, answer) => {
    jest.mocked(apiGet).mockImplementation(answer as typeof apiGet);
    await renderWithQuery(<ProfileChecklistCard />);

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("profile-checklist")).toBeNull();
  });

  it("asks nothing for a customer", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
    await renderWithQuery(<ProfileChecklistCard />);

    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId("profile-checklist")).toBeNull();
  });
});

describe("ProOnly (the /pro routes)", () => {
  const PRO_SCREEN = <Text>pro screen</Text>;

  it("builds the pro's screens for a pro", async () => {
    await renderWithQuery(<ProOnly>{PRO_SCREEN}</ProOnly>);

    expect(screen.getByText("pro screen")).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it.each(["customer", "admin"] as const)("sends a signed-in %s home", async (role) => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role }));
    await renderWithQuery(<ProOnly>{PRO_SCREEN}</ProOnly>);

    expect(screen.queryByText("pro screen")).toBeNull();
    expect(mockRedirect).toHaveBeenCalledWith({ href: "/" });
  });
});
