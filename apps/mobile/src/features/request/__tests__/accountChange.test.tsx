import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { router, Stack } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { createElement, type ComponentType } from "react";
import { Alert, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  attachQueryClient,
  login,
  logout,
  uploadMedia,
  useSession,
  type SessionUser,
  type UploadMediaOptions,
} from "@/api";

import {
  authResponse,
  callPath,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  secureStoreMock,
  user,
} from "../../../api/__tests__/helpers";
import { sessionStore } from "../../../api/session";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import { METRICS } from "../../auth/__tests__/helpers";
import { prepareMedia, type PreparedMedia } from "../../media/compress";
import { MediaSourceSheet } from "../../media/MediaSourceSheet";
import { RequestFlowLayout, useRequestFlowContext } from "../RequestFlowLayout";
import { requestDraftStore } from "../requestDraft";
import { FirstStepRoute } from "../stepRoutes";
import { HANDYMAN } from "./helpers";

// The Vault's probe (#263 V1): the flow's photos and videos belong to the account that picked
// them. A sign-in that brings another account while the flow is open (the flow stays mounted:
// the app is signed in throughout) cancels and drops them, and nothing the old account started
// (a picker, a compression, an upload) adds an item or uploads a file afterwards. Real session,
// real flow layout, Describe step and source sheet; the native picker, compression and upload are
// held by the test.
jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("@/api", () => ({ ...jest.requireActual("@/api"), uploadMedia: jest.fn() }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-image-manipulator", () => ({}));
jest.mock("../../media/compress", () => ({ prepareMedia: jest.fn() }));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const ACCOUNT_A = user;
const ACCOUNT_B: SessionUser = {
  ...user,
  id: "22222222-2222-4222-8222-222222222222",
  email: "ben@example.com",
};
const PRIVATE_PHOTO = "file:///private-A-photo.jpg";
const A_KEY = `u/${ACCOUNT_A.id}/request_media/${"a".repeat(32)}.jpg`;
const PREPARED: PreparedMedia = { uri: PRIVATE_PHOTO, kind: "image", contentType: "image/jpeg" };

let client: QueryClient;
let account: SessionUser;
let upload: ReturnType<typeof deferred<{ key: string }>>;
let uploads: { options: UploadMediaOptions; signedInAs: string | undefined }[];

async function signInAs(next: SessionUser): Promise<void> {
  account = next;
  await login({ email: next.email, password: "correct horse battery" });
}

/** What the flow holds, for the assertions the screen cannot show (keys, previews). */
function FlowProbe() {
  const { media } = useRequestFlowContext();
  const { user: current } = useSession();
  return (
    <>
      <Text testID="owner">{current?.id}</Text>
      <Text testID="media-items">{JSON.stringify(media.items)}</Text>
      <Text testID="media-keys">{JSON.stringify(media.keys)}</Text>
      <Text testID="probe-pick" onPress={() => void media.add("library")}>
        pick
      </Text>
    </>
  );
}

function HomeStub() {
  return <Text>home stub</Text>;
}

const routes = (firstStep: ComponentType) => ({
  _layout: () =>
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(
        QueryClientProvider,
        { client },
        createElement(Stack, { screenOptions: { headerShown: false } }),
      ),
    ),
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/(tabs)/index": HomeStub,
  "(app)/request/(flow)/_layout": RequestFlowLayout,
  "(app)/request/(flow)/new": firstStep,
  "(app)/request/(flow)/media-source": MediaSourceSheet,
});

/**
 * Lets the promise chains the test released run to their end. Microtasks only: the router's
 * testing library runs on fake timers, so a timer-based settle would never fire.
 */
const flushMicrotasks = () =>
  act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });

/** A, signed in, opens the request flow on Describe. */
async function openFlowAsA(firstStep: ComponentType = FirstStepRoute) {
  await signInAs(ACCOUNT_A);
  requestDraftStore.setState({ categorySlug: HANDYMAN.slug });
  const result = await renderRouter(routes(firstStep), { initialUrl: "/request/new" });
  return result;
}

/**
 * Picks A's photo through the real source sheet. The sheet stays up while the picker is open, so
 * Describe is back in front only once the picker has answered.
 */
async function pickThroughSheet({ pickerAnswers = true } = {}): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("media-add")).toBeTruthy());
  await fireEvent.press(screen.getByTestId("media-add"));
  await waitFor(() => expect(screen.getByTestId("media-source-library")).toBeTruthy());
  await fireEvent.press(screen.getByTestId("media-source-library"));
  if (pickerAnswers) await waitFor(() => expect(screen.getByTestId("describe-text")).toBeTruthy());
}

beforeEach(() => {
  jest.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  attachQueryClient(client);
  resetSecureStore();
  upload = deferred();
  uploads = [];
  jest.mocked(prepareMedia).mockReset().mockResolvedValue(PREPARED);
  jest.mocked(uploadMedia).mockImplementation((options) => {
    uploads.push({ options, signedInAs: sessionStore.getState().user?.id });
    return upload.promise;
  });
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
    canceled: false,
    assets: [
      { uri: PRIVATE_PHOTO, width: 100, height: 100, type: "image", mimeType: "image/jpeg" },
    ],
  });
  installFetchMock().mockImplementation(async (url) => {
    const path = callPath([url, undefined]);
    if (path === "/v1/auth/login") return jsonResponse(200, { ...authResponse(1), user: account });
    if (path === "/v1/auth/logout") return jsonResponse(204);
    if (path === "/v1/categories") return jsonResponse(200, [HANDYMAN]);
    return errorResponse(404, "not_found");
  });
});

afterEach(async () => {
  await act(() => logout());
});

describe("the request flow's media across an account change", () => {
  it("A's finished upload is gone for B: no item, preview or key, and nothing guards leaving", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation();
    try {
      const result = await openFlowAsA(FlowProbe);
      await waitFor(() => expect(screen.getByTestId("owner")).toHaveTextContent(ACCOUNT_A.id));
      await fireEvent.press(screen.getByTestId("probe-pick"));
      await waitFor(() => expect(uploads).toHaveLength(1));
      await act(async () => upload.resolve({ key: A_KEY }));
      expect(screen.getByTestId("media-keys")).toHaveTextContent(A_KEY, { exact: false });

      await act(() => signInAs(ACCOUNT_B));

      await waitFor(() => expect(screen.getByTestId("owner")).toHaveTextContent(ACCOUNT_B.id));
      expect(screen.getByTestId("media-items")).toHaveTextContent("[]");
      expect(screen.getByTestId("media-keys")).toHaveTextContent("[]");
      expect(screen.queryByText(new RegExp(PRIVATE_PHOTO))).toBeNull();

      // B leaves the flow: no "Discard request?" for A's photo, and nothing blocks the way.
      await act(() => router.back());
      await waitFor(() => expect(result.getPathname()).toBe("/"));
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  it("A's upload in flight is cancelled when B signs in", async () => {
    await openFlowAsA();
    await pickThroughSheet();
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0].options.signal?.aborted).toBe(false);

    await act(() => signInAs(ACCOUNT_B));

    expect(uploads[0].options.signal?.aborted).toBe(true);
  });

  it("A's photo compressed after B signed in is never uploaded", async () => {
    const compressed = deferred<PreparedMedia>();
    jest.mocked(prepareMedia).mockImplementationOnce(() => compressed.promise);
    await openFlowAsA();
    await pickThroughSheet();
    await waitFor(() => expect(prepareMedia).toHaveBeenCalledTimes(1));

    await act(() => signInAs(ACCOUNT_B));
    await act(async () => compressed.resolve(PREPARED));
    await flushMicrotasks();

    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("A's photo compressed while B's sign-in is being stored is never uploaded", async () => {
    const compressed = deferred<PreparedMedia>();
    jest.mocked(prepareMedia).mockImplementationOnce(() => compressed.promise);
    await openFlowAsA();
    await pickThroughSheet();
    await waitFor(() => expect(prepareMedia).toHaveBeenCalledTimes(1));

    // B's sign-in has its answer and a new session generation, but still writes the refresh token:
    // the session in memory is A's for that long, so only the item's own generation stops it.
    const stored = deferred<void>();
    secureStoreMock.setItemAsync.mockImplementationOnce(() => stored.promise);
    let signedIn!: Promise<void>;
    await act(async () => {
      signedIn = signInAs(ACCOUNT_B);
    });
    await waitFor(() => expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(2));
    expect(sessionStore.getState().user?.id).toBe(ACCOUNT_A.id);

    try {
      await act(async () => compressed.resolve(PREPARED));
      await flushMicrotasks();
      expect(uploadMedia).not.toHaveBeenCalled();
    } finally {
      // Released on a failure too: the next test's sign-out queues behind this write.
      await act(async () => {
        stored.resolve();
        await signedIn;
      });
    }
    expect(sessionStore.getState().user?.id).toBe(ACCOUNT_B.id);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("the picker's answer to A, arriving after B signed in, adds nothing", async () => {
    const answered = deferred<ImagePicker.ImagePickerResult>();
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockImplementationOnce(() => answered.promise);
    await openFlowAsA();
    await pickThroughSheet({ pickerAnswers: false });
    await waitFor(() => expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1));

    await act(() => signInAs(ACCOUNT_B));
    await act(async () =>
      answered.resolve({
        canceled: false,
        assets: [
          { uri: PRIVATE_PHOTO, width: 100, height: 100, type: "image", mimeType: "image/jpeg" },
        ],
      }),
    );
    await flushMicrotasks();

    expect(prepareMedia).not.toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("a sign-out cancels A's upload, as before", async () => {
    await openFlowAsA();
    await pickThroughSheet();
    await waitFor(() => expect(uploads).toHaveLength(1));

    await act(() => logout());

    expect(uploads[0].options.signal?.aborted).toBe(true);
  });
});
