import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { AccessibilityInfo } from "react-native";

import {
  ApiError,
  apiGet,
  apiPost,
  NetworkError,
  uploadMedia,
  UploadFailedError,
  useSession,
} from "@/api";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { prepareMedia, type PickedMedia } from "../../media/compress";
import { chooseMediaSource } from "../../media/mediaSource";
import { myDocumentsQueryKey } from "../api";
import type { MyDocuments, ProDocument } from "../documents";
import { DocumentScreen } from "../DocumentScreen";
import { ProDocumentsScreen } from "../ProDocumentsScreen";
import {
  document,
  documents,
  navigation,
  newQueryClient,
  NOTHING_SENT,
  renderWithQuery,
  signedIn,
  URL_MARK,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
// Where a redirect sends the screen; it draws nothing.
const mockRedirect = jest.fn((_props: { href: string }) => null);
jest.mock("expo-router", () => ({
  ...jest.requireActual("./helpers").routerMock,
  Redirect: (props: { href: string }) => mockRedirect(props),
}));
// Root manual mock (apps/mobile/__mocks__): named here so the test and the screen share one instance.
jest.mock("expo-haptics");
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
jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock("expo-image-manipulator", () => ({}));
jest.mock("../../media/compress", () => ({ prepareMedia: jest.fn(), compressImage: jest.fn() }));
// "Camera or library" answers at once: the sheet's route is not part of these screens.
jest.mock("../../media/mediaSource", () => ({
  ...jest.requireActual("../../media/mediaSource"),
  chooseMediaSource: jest.fn(),
  closeMediaSourceSheet: jest.fn(),
}));

const { mockSession, mockSignOut } = jest.requireMock<{
  mockSession: { generation: number };
  mockSignOut: () => void;
}>("@/api");

const DOCUMENTS = "/v1/pros/me/documents";
const SENT = { auth: true, generation: 1 };
const OFFLINE = "You're offline. Check your connection and try again.";
const UPLOAD_KEY = "uploads/pro-document/new";
/** A day that is never in the past, whenever the suite runs. */
const LATER = "12/31/2999";

/** What GET /v1/pros/me/documents answers now. */
let server: MyDocuments;
/** The photo upload in flight, settled by hand. */
let upload: { resolve: () => void; reject: (error: unknown) => void } | null;
let client: QueryClient;
let consoleSpies: jest.SpyInstance[];

const flush = () => act(async () => settle());
const pressed = (testID: string) => act(async () => fireEvent.press(screen.getByTestId(testID)));
const typed = (testID: string, text: string) =>
  act(async () => fireEvent.changeText(screen.getByTestId(testID), text));
const labelOf = (testID: string) => screen.getByTestId(testID).props.accessibilityLabel as string;
const stateOf = (testID: string) =>
  screen.getByTestId(testID).props.accessibilityState as { disabled?: boolean };
const photoStatus = () => screen.getByTestId("pro-document-photo-status").props.children as string;
const posts = () => jest.mocked(apiPost).mock.calls.map(([, body]) => body);
const announced = () =>
  jest
    .mocked(AccessibilityInfo.announceForAccessibilityWithOptions)
    .mock.calls.map(([text]) => text);
const submit = () => pressed("pro-document-submit");

async function openList(data: MyDocuments = NOTHING_SENT) {
  server = data;
  await renderWithQuery(<ProDocumentsScreen />, client);
  await screen.findByTestId(`pro-document-${data.required_types[0]}`);
}

/** Opens one type's screen and waits for its Submit button (the list answered). */
async function openType(type: string, data: MyDocuments = NOTHING_SENT) {
  server = data;
  navigation.setParams({ type });
  await renderWithQuery(<DocumentScreen />, client);
  await screen.findByTestId("pro-document-submit");
}

/** The list is not answered again: what the cache holds after a submission is the app's own doing. */
const holdTheList = () =>
  jest.mocked(apiGet).mockImplementation((() => new Promise(() => undefined)) as typeof apiGet);

/** Picks a photo from the library and lets its upload finish. */
async function addPhoto() {
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "file:///picked/1.jpg", width: 800, height: 600, type: "image" }],
  });
  await pressed("pro-document-photo-choose");
  await flush();
  await act(async () => upload?.resolve());
}

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
  mockSession.generation = 1;
  client = newQueryClient();
  server = NOTHING_SENT;
  upload = null;
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockImplementation((async () => server) as unknown as typeof apiGet);
  jest.mocked(apiPost).mockReset();
  jest.mocked(chooseMediaSource).mockResolvedValue("library");
  jest.mocked(prepareMedia).mockImplementation(async (file: PickedMedia) => ({
    uri: `${file.uri}.compressed`,
    contentType: "image/jpeg",
    kind: file.kind,
  }));
  jest.mocked(uploadMedia).mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        upload = { resolve: () => resolve({ key: UPLOAD_KEY }), reject };
      }),
  );
  jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation(() => undefined);
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    jest.spyOn(console, method),
  );
});

afterEach(async () => {
  await flush();
  // A signed URL is shown inside the app only, and an upload's key goes to the API only:
  // neither reaches a log, as an argument or inside an error.
  for (const spy of consoleSpies) {
    // An Error serialises as {} on its own: its message and stack are read too.
    const logged = JSON.stringify(spy.mock.calls, (_key, value: unknown) =>
      value instanceof Error ? `${value.name}: ${value.message} ${value.stack}` : value,
    );
    expect(logged).not.toContain(URL_MARK);
    expect(logged).not.toContain(UPLOAD_KEY);
  }
  jest.restoreAllMocks();
});

describe("ProDocumentsScreen", () => {
  it("lists the required types as missing while nothing was sent", async () => {
    await openList();

    expect(apiGet).toHaveBeenCalledWith(DOCUMENTS, expect.objectContaining(SENT));
    expect(labelOf("pro-document-id")).toBe("Photo ID: Missing");
    expect(labelOf("pro-document-insurance")).toBe("Insurance: Missing");
    expect(screen.queryByTestId("pro-document-license")).toBeNull();
  });

  it("adds the license when the API requires it, between the ID and the insurance", async () => {
    await openList({
      ...NOTHING_SENT,
      required_types: ["id", "license", "insurance"],
      missing_types: ["id", "license", "insurance"],
    });

    const order = screen
      .getAllByTestId(/^pro-document-(id|license|insurance)$/)
      .map((row) => row.props.testID as string);
    expect(order).toEqual(["pro-document-id", "pro-document-license", "pro-document-insurance"]);
  });

  it("shows where each document stands, and why one was rejected", async () => {
    await openList(
      documents([
        document({ doc_type: "id", status: "approved" }),
        document({
          doc_type: "insurance",
          status: "rejected",
          rejection_reason: "The policy number is cut off.",
          expires_on: "2027-03-12",
        }),
      ]),
    );

    expect(labelOf("pro-document-id")).toBe("Photo ID: Approved");
    expect(labelOf("pro-document-insurance")).toBe(
      "Insurance: Rejected. Reason: The policy number is cut off. Expires Mar 12, 2027",
    );
    expect(
      screen.getByText("Reason: The policy number is cut off.", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it("shows a document waiting for the review as In review", async () => {
    await openList(documents([document({ doc_type: "id", status: "pending" })]));

    expect(labelOf("pro-document-id")).toBe("Photo ID: In review");
  });

  it("asks nothing for a customer", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
    await renderWithQuery(<ProDocumentsScreen />, client);
    await flush();

    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pro-document-id")).toBeNull();
  });

  it("a row opens its type", async () => {
    await openList();
    await pressed("pro-document-insurance");

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/pro/documents/[type]",
      params: { type: "insurance" },
    });
  });

  it("shows row-shaped placeholders while the list loads", async () => {
    jest.mocked(apiGet).mockImplementation((() => new Promise(() => undefined)) as typeof apiGet);
    await renderWithQuery(<ProDocumentsScreen />, client);

    expect(screen.getByLabelText("Loading your documents")).toBeTruthy();
  });

  it.each([
    ["offline", new NetworkError(false), OFFLINE],
    ["a 5xx", new ApiError(500, undefined), "Give it another try in a moment."],
    ["a 4xx", new ApiError(403, "forbidden"), "Give it another try in a moment."],
  ])(
    "%s while loading says so, with a retry that lists the documents",
    async (_case, error, body) => {
      jest.mocked(apiGet).mockRejectedValueOnce(error);
      await renderWithQuery(<ProDocumentsScreen />, client);

      const notice = await screen.findByTestId("pro-documents-load-failed");
      expect(notice).toHaveTextContent(`We couldn't load your documents${body}Try again`);

      await pressed("pro-documents-retry");
      expect(await screen.findByTestId("pro-document-id")).toBeTruthy();
    },
  );

  it("keeps the rows when a refresh fails, with a way to ask again", async () => {
    await openList();
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    await act(async () => {
      await client.refetchQueries({ queryKey: myDocumentsQueryKey(1) });
    });

    expect(await screen.findByTestId("pro-documents-stale")).toBeTruthy();
    expect(screen.getByTestId("pro-document-id")).toBeTruthy();

    await pressed("pro-documents-refresh");
    await waitFor(() => expect(screen.queryByTestId("pro-documents-stale")).toBeNull());
  });
});

describe("DocumentScreen", () => {
  it("a type the API does not know goes to the list", async () => {
    navigation.setParams({ type: "passport" });
    await renderWithQuery(<DocumentScreen />, client);

    expect(mockRedirect).toHaveBeenCalledWith({ href: "/pro/documents" });
    expect(screen.queryByTestId("pro-document-submit")).toBeNull();
  });

  it("Submit with no photo says so and asks nothing", async () => {
    await openType("id");
    await submit();

    expect(photoStatus()).toBe("Add a photo of the document first.");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("an ID: the photo uploads as a document, and Submit sends its type and key", async () => {
    await openType("id");
    // An ID has no expiry to give.
    expect(screen.queryByTestId("pro-document-expiry")).toBeNull();
    const sent = document({ doc_type: "id" });
    jest.mocked(apiPost).mockResolvedValueOnce(sent as never);
    await addPhoto();

    expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ purpose: "pro_document" }));
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ["images"], selectionLimit: 1 }),
    );
    expect(photoStatus()).toBe("Photo ready. Submit to send it for review.");
    holdTheList();
    await submit();

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(DOCUMENTS, { doc_type: "id", file_key: UPLOAD_KEY }, SENT);
    // The cached list has it at once: the ID is no longer missing.
    expect(client.getQueryData<MyDocuments>(myDocumentsQueryKey(1))).toMatchObject({
      documents: [sent],
      missing_types: ["insurance"],
    });
    expect(announced()).toContain("Document sent for review");
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("two quick presses send one document", async () => {
    await openType("id");
    await addPhoto();
    const answer = deferred<ProDocument>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);
    await submit();
    await submit();

    expect(apiPost).toHaveBeenCalledTimes(1);
    await act(async () => answer.resolve(document({ doc_type: "id" })));
  });

  it("asks for the list again once the document is in", async () => {
    await openType("id");
    await addPhoto();
    const sent = document({ doc_type: "id" });
    jest.mocked(apiPost).mockResolvedValueOnce(sent as never);
    server = documents([sent]);
    jest.mocked(apiGet).mockClear();
    await submit();

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(DOCUMENTS, expect.objectContaining(SENT)),
    );
  });

  it("a retry refused because the first try went through shows the document in review", async () => {
    await openType("id");
    await addPhoto();
    // The first answer is lost on the way back: the server has the document.
    jest
      .mocked(apiPost)
      .mockRejectedValueOnce(new NetworkError(true))
      .mockRejectedValueOnce(new ApiError(422, "invalid_media"));
    await submit();
    expect(screen.getByTestId("pro-document-failure")).toHaveTextContent(OFFLINE);

    const stored = document({ doc_type: "id", status: "pending" });
    server = documents([stored]);
    await submit();

    // The list was asked again: the screen shows what the server holds.
    await waitFor(() =>
      expect(screen.getByTestId("pro-document-status")).toHaveTextContent("In review"),
    );
    expect(screen.getByTestId("pro-document-photo-image").props.source).toEqual({
      uri: stored.url,
    });
  });

  it("a saved picture that did not load is tried again from the next answer's URL", async () => {
    const pending = document({ doc_type: "id", status: "pending" });
    await openType("id", documents([pending]));
    await act(async () =>
      fireEvent(screen.getByTestId("pro-document-photo-image"), "error", { nativeEvent: {} }),
    );

    expect(screen.queryByTestId("pro-document-photo-image")).toBeNull();
    expect(screen.getByTestId("pro-document-photo-frame").props.accessibilityLabel).toBe(
      "The document's photo can't be shown right now",
    );

    // The same document, listed again with a fresh signed URL.
    const fresh = { ...pending, url: pending.url.replace("sig-", "sig-fresh-") };
    server = documents([fresh]);
    await act(async () => {
      await client.refetchQueries({ queryKey: myDocumentsQueryKey(1) });
    });

    const image = await screen.findByTestId("pro-document-photo-image");
    expect(image.props.source).toEqual({ uri: fresh.url });
  });

  it("an insurance: the expiry date goes as the API's date", async () => {
    await openType("insurance");
    jest.mocked(apiPost).mockResolvedValueOnce(document({ doc_type: "insurance" }) as never);
    await addPhoto();
    await typed("pro-document-expiry", "12312999");

    expect(screen.getByTestId("pro-document-expiry").props.value).toBe(LATER);
    await submit();

    expect(posts()).toEqual([
      { doc_type: "insurance", file_key: UPLOAD_KEY, expires_on: "2999-12-31" },
    ]);
  });

  it("the expiry date is optional: a license goes without one", async () => {
    await openType("license", {
      ...NOTHING_SENT,
      required_types: ["id", "license", "insurance"],
    });
    jest.mocked(apiPost).mockResolvedValueOnce(document({ doc_type: "license" }) as never);
    await addPhoto();
    await submit();

    expect(posts()).toEqual([{ doc_type: "license", file_key: UPLOAD_KEY }]);
  });

  it.each([
    ["a day already past", "01012020", "Enter today's date or a later one."],
    ["a day that does not exist", "02302999", "Enter the date as MM/DD/YYYY."],
    ["a date cut short", "0312", "Enter the date as MM/DD/YYYY."],
  ])("%s is refused before any request", async (_case, digits, message) => {
    await openType("insurance");
    await addPhoto();
    await typed("pro-document-expiry", digits);
    await submit();

    expect(screen.getByTestId("pro-document-expiry").props.accessibilityHint).toBe(message);
    expect(apiPost).not.toHaveBeenCalled();

    // Fixed, it goes.
    jest.mocked(apiPost).mockResolvedValueOnce(document({ doc_type: "insurance" }) as never);
    await typed("pro-document-expiry", LATER);
    await submit();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("a document in review can be replaced: the new one takes its place in the list", async () => {
    const pending = document({ doc_type: "insurance", status: "pending" });
    const id = document({ doc_type: "id", status: "approved" });
    await openType("insurance", documents([id, pending]));

    expect(screen.getByTestId("pro-document-pending")).toHaveTextContent(
      "Sending a new photo replaces the one in review.",
    );
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    // The one on file shows until a new photo is chosen.
    expect(screen.getByTestId("pro-document-photo-image").props.source).toEqual({
      uri: pending.url,
    });

    const replacement = document({ doc_type: "insurance", status: "pending" });
    jest.mocked(apiPost).mockResolvedValueOnce(replacement as never);
    await addPhoto();
    holdTheList();
    await submit();

    expect(posts()).toEqual([{ doc_type: "insurance", file_key: UPLOAD_KEY }]);
    expect(client.getQueryData<MyDocuments>(myDocumentsQueryKey(1))?.documents).toEqual([
      replacement,
      id,
    ]);
  });

  it("a rejected document shows the reason, and takes a new photo", async () => {
    const rejected = document({
      doc_type: "id",
      status: "rejected",
      rejection_reason: "The photo is too dark to read.",
    });
    await openType("id", documents([rejected]));

    expect(screen.getByTestId("pro-document-status")).toHaveTextContent("Rejected");
    expect(screen.getByTestId("pro-document-rejected")).toHaveTextContent(
      "This document was rejectedThe photo is too dark to read.",
    );

    jest.mocked(apiPost).mockResolvedValueOnce(document({ doc_type: "id" }) as never);
    await addPhoto();
    await submit();
    expect(posts()).toEqual([{ doc_type: "id", file_key: UPLOAD_KEY }]);
  });

  it("a rejection without a reason still says what to do", async () => {
    await openType("id", documents([document({ status: "rejected", rejection_reason: null })]));

    expect(screen.getByTestId("pro-document-rejected")).toHaveTextContent(
      "This document was rejectedSend a new photo of it.",
    );
  });

  it("a photo that does not upload says so, with a retry, and Submit waits for one", async () => {
    await openType("id");
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///picked/1.jpg", width: 800, height: 600, type: "image" }],
    });
    await pressed("pro-document-photo-choose");
    await flush();
    // Submit waits for the upload.
    expect(stateOf("pro-document-submit").disabled).toBe(true);
    await act(async () => upload?.reject(new UploadFailedError("network")));
    await flush();

    expect(photoStatus()).toBe("Upload failed. Check your connection and try again.");
    await submit();
    expect(apiPost).not.toHaveBeenCalled();

    jest.mocked(apiPost).mockResolvedValueOnce(document({ doc_type: "id" }) as never);
    await pressed("pro-document-photo-retry");
    await flush();
    await act(async () => upload?.resolve());
    await submit();
    expect(posts()).toEqual([{ doc_type: "id", file_key: UPLOAD_KEY }]);
  });

  it("a photo the API refuses is set aside, and the date stays as typed", async () => {
    await openType("insurance");
    await addPhoto();
    await typed("pro-document-expiry", LATER);
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(422, "invalid_media"));
    await submit();

    expect(screen.getByTestId("pro-document-failure")).toHaveTextContent(
      "We couldn't use that photo. Choose another one.",
    );
    expect(photoStatus()).toBe("Take a clear photo of the whole document.");
    expect(screen.getByTestId("pro-document-expiry").props.value).toBe(LATER);
    expect(router.back).not.toHaveBeenCalled();
  });

  it.each([
    ["offline", new NetworkError(false), OFFLINE],
    ["a timeout", new NetworkError(true), OFFLINE],
    ["a 5xx", new ApiError(503, undefined), "We couldn't submit this document. Try again."],
    [
      "a 4xx",
      new ApiError(422, "validation_error"),
      "We couldn't submit this document. Try again.",
    ],
  ])(
    "%s on Submit says so, keeps the photo, and Submit works again",
    async (_case, error, message) => {
      await openType("id");
      await addPhoto();
      jest
        .mocked(apiPost)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(document({ doc_type: "id" }) as never);
      await submit();

      expect(screen.getByTestId("pro-document-failure")).toHaveTextContent(message);
      expect(announced()).toContain(message);
      expect(photoStatus()).toBe("Photo ready. Submit to send it for review.");
      expect(router.back).not.toHaveBeenCalled();

      await submit();
      expect(posts()).toEqual([
        { doc_type: "id", file_key: UPLOAD_KEY },
        { doc_type: "id", file_key: UPLOAD_KEY },
      ]);
      expect(router.back).toHaveBeenCalledTimes(1);
    },
  );

  it("a submission answered after the session changed leaves the screen alone", async () => {
    await openType("id");
    await addPhoto();
    const answer = deferred<ProDocument>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);
    await submit();

    await act(async () => {
      mockSignOut();
      answer.resolve(document({ doc_type: "id" }));
    });
    await flush();

    expect(router.back).not.toHaveBeenCalled();
    expect(announced()).not.toContain("Document sent for review");
  });

  it.each([
    ["offline", new NetworkError(false), OFFLINE],
    ["a 5xx", new ApiError(500, undefined), "Give it another try in a moment."],
  ])("opened straight from a link, %s says so with a retry", async (_case, error, body) => {
    jest.mocked(apiGet).mockRejectedValueOnce(error);
    navigation.setParams({ type: "id" });
    await renderWithQuery(<DocumentScreen />, client);

    const notice = await screen.findByTestId("pro-document-load-failed");
    expect(notice).toHaveTextContent(`We couldn't load your documents${body}Try again`);

    await pressed("pro-document-retry");
    expect(await screen.findByTestId("pro-document-submit")).toBeTruthy();
  });
});
