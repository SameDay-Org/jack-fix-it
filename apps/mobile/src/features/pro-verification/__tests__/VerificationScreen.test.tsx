import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

import { ApiError, apiGet, NetworkError, useSession } from "@/api";

import { settle } from "../../../api/__tests__/helpers";
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
import { VerificationScreen } from "../VerificationScreen";

jest.mock("@/api", () => jest.requireActual("../../pro-documents/__tests__/helpers").apiMock());
jest.mock(
  "expo-router",
  () => jest.requireActual("../../pro-documents/__tests__/helpers").routerMock,
);
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
const OFFLINE = "You're offline. Check your connection and try again.";
const REJECTED: ProProfile = { ...FULL_PROFILE, verification_status: "rejected" };
const APPROVED: ProProfile = { ...FULL_PROFILE, verification_status: "approved" };

/** What the API answers now, by path; an Error is thrown. */
let server: { profile: ProProfile | Error; documents: MyDocuments | Error };

const flush = () => act(async () => settle());
const pressed = (testID: string) => act(async () => fireEvent.press(screen.getByTestId(testID)));
const paths = () => jest.mocked(apiGet).mock.calls.map(([path]) => path as string);
const message = () => screen.getByTestId("verification-message");

async function open(profile: ProProfile | Error, list: MyDocuments | Error = NOTHING_SENT) {
  server = { profile, documents: list };
  await renderWithQuery(<VerificationScreen />);
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockImplementation((async (path: string) => {
    const answer = path === PROFILE ? server.profile : server.documents;
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof apiGet);
});

afterEach(async () => {
  await flush();
});

describe("VerificationScreen", () => {
  it("Pending: says the team reviews the profile and the documents, with no date", async () => {
    await open(EMPTY_PROFILE);

    expect(screen.getByTestId("verification-status")).toHaveTextContent("Pending");
    expect(message()).toHaveTextContent(
      "Your verification is pendingOur team reviews your profile and documents before you start receiving requests. The result shows up here.",
    );
    // No promise of a time.
    expect(message()).not.toHaveTextContent(/hour|day|soon|minute/i);
    expect(screen.queryByTestId("verification-fix")).toBeNull();
    expect(screen.queryByTestId("verification-payouts")).toBeNull();
  });

  it.each([
    ["verification-profile", "Pro profile, 0 of 4 done", "/pro/profile"],
    ["verification-documents", "Documents, 1 of 2 sent", "/pro/documents"],
  ])("Pending: %s says how far it is, and opens it", async (testID, name, href) => {
    await open(EMPTY_PROFILE, documents([document({ doc_type: "id", status: "pending" })]));

    expect(await screen.findByRole("button", { name })).toBeTruthy();
    await pressed(testID);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(href);
  });

  it("Pending with everything in says so on each row", async () => {
    await open(
      FULL_PROFILE,
      documents([
        document({ doc_type: "id", status: "pending" }),
        document({ doc_type: "insurance", status: "approved" }),
      ]),
    );

    expect(await screen.findByRole("button", { name: "Pro profile, Complete" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Documents, All sent" })).toBeTruthy();
  });

  it("Approved without payouts: what is next, as a placeholder labelled Coming soon", async () => {
    await open(APPROVED);

    expect(screen.getByTestId("verification-status")).toHaveTextContent("Approved");
    expect(message()).toHaveTextContent(
      "You're approvedOne step is left before requests reach you: payout setup.",
    );
    expect(screen.getByTestId("verification-payouts")).toHaveTextContent(
      /^Payout setup\s*Coming soon\s*You'll set up how you get paid here\. It isn't available in the app yet\.$/,
    );
    // A placeholder is not a control: nothing on the screen but Back can be pressed.
    expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      "Back",
    ]);
    // An approved pro's screen asks for no document.
    expect(paths()).not.toContain(DOCUMENTS);
  });

  it("Approved with payouts on: requests show up on Home, and no placeholder", async () => {
    await open({ ...APPROVED, payouts_enabled: true });

    expect(message()).toHaveTextContent("You're approvedNew requests near you show up on Home.");
    expect(screen.queryByTestId("verification-payouts")).toBeNull();
  });

  it("Rejected: shows why each document was refused, and the way to fix them", async () => {
    await open(
      REJECTED,
      documents([
        document({
          doc_type: "id",
          status: "rejected",
          rejection_reason: "The photo is too dark to read.",
        }),
        document({ doc_type: "insurance", status: "approved" }),
      ]),
    );

    expect(screen.getByTestId("verification-status")).toHaveTextContent("Rejected");
    expect(message()).toHaveTextContent(
      "Your verification wasn't approvedReview your profile and your documents, fix what's listed here, and send it again.",
    );
    expect(await screen.findByTestId("verification-reason-id")).toHaveTextContent(
      "Photo IDThe photo is too dark to read.",
    );
    expect(screen.queryByTestId("verification-reason-insurance")).toBeNull();

    await pressed("verification-fix");
    expect(router.push).toHaveBeenLastCalledWith("/pro/documents");
  });

  it("Rejected with no rejected document: no reason is made up, the fix stays", async () => {
    await open(REJECTED, documents([document({ doc_type: "id", status: "approved" })]));

    await waitFor(() => expect(paths()).toContain(DOCUMENTS));
    await flush();
    expect(screen.queryByTestId("verification-reasons")).toBeNull();
    expect(screen.getByRole("button", { name: "Fix documents" })).toBeTruthy();
  });

  it("Rejected while the documents do not load: says so with a retry, the fix stays", async () => {
    await open(REJECTED, new NetworkError(false));

    expect(await screen.findByTestId("verification-reasons-error")).toHaveTextContent(
      "We couldn't load your documents.Try again",
    );
    expect(screen.getByRole("button", { name: "Fix documents" })).toBeTruthy();

    server.documents = documents([
      document({ doc_type: "id", status: "rejected", rejection_reason: "Blurry." }),
    ]);
    await pressed("verification-reasons-error-action");
    expect(await screen.findByTestId("verification-reason-id")).toHaveTextContent(
      "Photo IDBlurry.",
    );
  });

  it("shows a placeholder while the status loads", async () => {
    jest.mocked(apiGet).mockImplementation((() => new Promise(() => undefined)) as typeof apiGet);
    await renderWithQuery(<VerificationScreen />);

    expect(screen.getByLabelText("Loading your verification status")).toBeTruthy();
    expect(screen.queryByTestId("verification-status")).toBeNull();
  });

  it.each([
    ["offline", new NetworkError(false), OFFLINE],
    ["a 5xx", new ApiError(500, undefined), "Give it another try in a moment."],
    ["a 4xx", new ApiError(403, "forbidden"), "Give it another try in a moment."],
  ])("%s says so, with a retry that shows the status", async (_case, error, body) => {
    await open(error);

    expect(await screen.findByTestId("verification-load-failed")).toHaveTextContent(
      `We couldn't load your verification status${body}Try again`,
    );

    server.profile = EMPTY_PROFILE;
    await pressed("verification-retry");
    expect(await screen.findByTestId("verification-status")).toHaveTextContent("Pending");
  });

  it("asks nothing for a customer", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
    await open(EMPTY_PROFILE);

    expect(apiGet).not.toHaveBeenCalled();
  });
});
