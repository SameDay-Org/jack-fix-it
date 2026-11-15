import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

import { ApiError, apiGet, NetworkError, useSession } from "@/api";

import { settle } from "../../../api/__tests__/helpers";
import { page, summary } from "../../opportunities/__tests__/helpers";
import {
  document,
  documents,
  navigation,
  NOTHING_SENT,
  renderWithQuery,
  signedIn,
} from "../../pro-documents/__tests__/helpers";
import type { MyDocuments } from "../../pro-documents/documents";
import type { ProProfile } from "../../pro-profile";
import { EMPTY_PROFILE, FULL_PROFILE } from "../../pro-profile/__tests__/helpers";
import { ProHomeScreen } from "../ProHomeScreen";

jest.mock("@/api", () => jest.requireActual("../../pro-documents/__tests__/helpers").apiMock());
jest.mock(
  "expo-router",
  () => jest.requireActual("../../pro-documents/__tests__/helpers").routerMock,
);
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

const PROFILE = "/v1/pros/me";
const DOCUMENTS = "/v1/pros/me/documents";
const OPPORTUNITIES = "/v1/pros/me/opportunities";
const REJECTED: ProProfile = { ...FULL_PROFILE, verification_status: "rejected" };
const APPROVED: ProProfile = { ...FULL_PROFILE, verification_status: "approved" };
const REQUEST = summary(1);

/** What the API answers now, by path; an Error is thrown. */
let server: { profile: ProProfile | Error; documents: MyDocuments };

const flush = () => act(async () => settle());
const pressed = (testID: string) => act(async () => fireEvent.press(screen.getByTestId(testID)));
const paths = () => jest.mocked(apiGet).mock.calls.map(([path]) => path as string);
const labelOf = (testID: string) => screen.getByTestId(testID).props.accessibilityLabel as string;

async function open(profile: ProProfile | Error, list: MyDocuments = NOTHING_SENT) {
  server = { profile, documents: list };
  await renderWithQuery(<ProHomeScreen />);
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));
  jest.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path === OPPORTUNITIES) return page([REQUEST]);
    if (path === DOCUMENTS) return server.documents;
    if (server.profile instanceof Error) throw server.profile;
    return server.profile;
  }) as unknown as typeof apiGet);
});

afterEach(async () => {
  await flush();
});

describe("the pro's home until the pro is approved (#38)", () => {
  it("a pending pro sees the status and what is left, and no request is asked for", async () => {
    await open(EMPTY_PROFILE);

    expect(screen.getByTestId("pro-home-greeting")).toHaveTextContent("Hi, Dan");
    expect(labelOf("verification-banner")).toBe(
      "Verification: Pending. Our team reviews your profile and documents before you start receiving requests.",
    );
    expect(screen.getByTestId("profile-checklist-progress")).toHaveTextContent("0 of 4 done");
    expect(await screen.findByTestId("documents-checklist-progress")).toHaveTextContent(
      "0 of 2 sent",
    );
    expect(labelOf("documents-checklist-id")).toBe("Photo ID: to do");
    expect(labelOf("documents-checklist-insurance")).toBe("Insurance: to do");

    // Pending pros cannot see requests: none listed, none asked for.
    expect(screen.queryByText("New opportunities")).toBeNull();
    expect(screen.queryByTestId(`opportunity-${REQUEST.dispatch_id}`)).toBeNull();
    expect(paths()).not.toContain(OPPORTUNITIES);
  });

  it("a rejected pro sees it on the home, with the documents to send again", async () => {
    await open(
      REJECTED,
      documents([
        document({ doc_type: "id", status: "rejected", rejection_reason: "Too dark." }),
        document({ doc_type: "insurance", status: "approved" }),
      ]),
    );

    expect(labelOf("verification-banner")).toBe(
      "Verification: Rejected. See what to fix and send it again.",
    );
    expect(await screen.findByTestId("documents-checklist-progress")).toHaveTextContent(
      "1 of 2 sent",
    );
    expect(labelOf("documents-checklist-id")).toBe("Photo ID: rejected");
    expect(labelOf("documents-checklist-insurance")).toBe("Insurance: sent");
    expect(paths()).not.toContain(OPPORTUNITIES);
  });

  it("the banner opens the status, and the documents card the documents", async () => {
    await open(EMPTY_PROFILE);

    await pressed("verification-banner");
    expect(router.push).toHaveBeenLastCalledWith("/pro/verification");
    navigation.reset();
    await pressed((await screen.findByTestId("documents-checklist-action")).props.testID);
    expect(router.push).toHaveBeenLastCalledWith("/pro/documents");
  });

  it("with the profile complete and every document in, only the status is left", async () => {
    await open(
      FULL_PROFILE,
      documents([
        document({ doc_type: "id", status: "pending" }),
        document({ doc_type: "insurance", status: "pending" }),
      ]),
    );

    await waitFor(() => expect(paths()).toContain(DOCUMENTS));
    await flush();
    expect(screen.getByTestId("verification-banner")).toBeTruthy();
    expect(screen.queryByTestId("profile-checklist")).toBeNull();
    expect(screen.queryByTestId("documents-checklist")).toBeNull();
    expect(paths()).not.toContain(OPPORTUNITIES);
  });

  it("an approved pro with payouts on sees the requests, and no banner", async () => {
    await open({ ...APPROVED, payouts_enabled: true });

    expect(await screen.findByTestId(`opportunity-${REQUEST.dispatch_id}`)).toBeTruthy();
    expect(screen.getByText("New opportunities")).toBeTruthy();
    expect(screen.queryByTestId("verification-banner")).toBeNull();
    expect(screen.queryByTestId("pro-onboarding")).toBeNull();
    // An approved pro's home asks for no document.
    expect(paths()).not.toContain(DOCUMENTS);
  });

  it("an approved pro without payouts sees the requests under what is next", async () => {
    await open(APPROVED);

    expect(await screen.findByTestId(`opportunity-${REQUEST.dispatch_id}`)).toBeTruthy();
    expect(labelOf("verification-banner")).toBe(
      "Verification: Approved. Next: payout setup. It isn't available in the app yet.",
    );
  });

  it("while the profile is not known, draws the shape of the checklist and asks for no request", async () => {
    jest.mocked(apiGet).mockImplementation((() => new Promise(() => undefined)) as typeof apiGet);
    await renderWithQuery(<ProHomeScreen />);
    await flush();

    expect(screen.getByLabelText("Loading your account")).toBeTruthy();
    expect(screen.getByTestId("pro-home-greeting")).toBeTruthy();
    expect(paths()).toEqual([PROFILE]);
  });

  it.each([
    ["offline", new NetworkError(false), "You're offline. Check your connection and try again."],
    [
      "a 5xx",
      new ApiError(503, undefined),
      "We couldn't load your account. Give it another try in a moment.",
    ],
    [
      "a 4xx",
      new ApiError(403, "forbidden"),
      "We couldn't load your account. Give it another try in a moment.",
    ],
  ])("%s says so with a retry, and still asks for no request", async (_case, error, message) => {
    await open(error);

    expect(await screen.findByTestId("pro-onboarding-error-message")).toHaveTextContent(message);
    expect(paths()).not.toContain(OPPORTUNITIES);

    server.profile = EMPTY_PROFILE;
    await pressed("pro-onboarding-error-action");
    expect(await screen.findByTestId("verification-banner")).toBeTruthy();
  });

  it("the approval shows as soon as the profile says so: the requests take the home", async () => {
    await open(EMPTY_PROFILE);
    expect(screen.getByTestId("pro-onboarding")).toBeTruthy();

    server.profile = { ...APPROVED, payouts_enabled: true };
    // The home comes back into focus: the profile is asked for again.
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));

    expect(await screen.findByTestId(`opportunity-${REQUEST.dispatch_id}`)).toBeTruthy();
    expect(screen.queryByTestId("pro-onboarding")).toBeNull();
  });
});
