import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { createElement } from "react";
import { Alert, Pressable, Text, type AlertButton } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ApiError, apiGet, apiPost, type SessionUser } from "@/api";
import type { MediaItem, MediaUpload } from "@/features/media";

import { user } from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import DescribeRoute from "../../../app/(app)/request/(flow)/describe";
import FlowLayout from "../../../app/(app)/request/(flow)/_layout";
import NewRoute from "../../../app/(app)/request/(flow)/new";
import ReviewRoute from "../../../app/(app)/request/(flow)/review";
import WhereRoute from "../../../app/(app)/request/(flow)/where";
import SentRoute from "../../../app/(app)/request/sent";
import { METRICS } from "../../auth/__tests__/helpers";
import { CATEGORIES_QUERY_KEY } from "../../home/useCategories";
import { TabsLayout } from "../../tabs/TabsLayout";
import { requestDraftStore, startRequest } from "../requestDraft";
import { created, HANDYMAN, PAINTING, savedAddress } from "./helpers";

const mockSignedIn: { status: "signedIn"; user: SessionUser } = { status: "signedIn", user };

// The flow's upload list, changed by a test inside `act` (an upload finishing, failing, removed).
const mockMedia: { current: MediaUpload | null; listeners: Set<() => void> } = {
  current: null,
  listeners: new Set(),
};

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  useSession: () => mockSignedIn,
}));
jest.mock("@/features/media", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  return {
    ...jest.requireActual("@/features/media"),
    useMediaUpload: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          mockMedia.listeners.add(listener);
          return () => mockMedia.listeners.delete(listener);
        },
        () => mockMedia.current,
      ),
  };
});
jest.mock("expo-image-picker", () => ({}));
jest.mock("expo-image-manipulator", () => ({}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const HOME_ADDRESS = savedAddress();
const UNSERVED = savedAddress({
  id: "10000000-0000-4000-8000-000000000002",
  label: "Mom's",
  line1: "5 Bleecker St",
  city: "New York",
  state: "NY",
  zip_code: "10012",
  is_default: false,
  served: false,
});

const media = (patch: Partial<MediaUpload> = {}): MediaUpload => ({
  items: [],
  max: 10,
  acceptsVideo: true,
  keys: [],
  remaining: 10,
  picking: false,
  permissionDenied: null,
  dismissPermissionNotice: jest.fn(),
  add: jest.fn(async () => undefined),
  retry: jest.fn(),
  remove: jest.fn(),
  ...patch,
});

const photo = (n: number, patch: Partial<MediaItem> = {}): MediaItem => ({
  id: `media-${n}`,
  kind: "image",
  previewUri: `file:///picked/${n}.jpg`,
  status: "done",
  progress: 1,
  key: `uploads/${n}.jpg`,
  failure: null,
  ...patch,
});

async function setMedia(next: MediaUpload): Promise<void> {
  await act(async () => {
    mockMedia.current = next;
    mockMedia.listeners.forEach((listener) => listener());
  });
}

/** A promise the test settles: the send in flight. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function HomeStub() {
  return (
    <>
      <Text>home stub</Text>
      <Pressable accessibilityRole="button" onPress={() => startRequest("painting")}>
        <Text>Painting card</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => startRequest("handyman")}>
        <Text>Handyman card</Text>
      </Pressable>
    </>
  );
}

function RequestStub() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`request ${id}`}</Text>;
}

let client: QueryClient;

const routes = {
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
  "(app)/(tabs)/_layout": TabsLayout,
  "(app)/(tabs)/index": HomeStub,
  "(app)/request/(flow)/_layout": FlowLayout,
  "(app)/request/(flow)/new": NewRoute,
  "(app)/request/(flow)/describe": DescribeRoute,
  "(app)/request/(flow)/where": WhereRoute,
  "(app)/request/(flow)/review": ReviewRoute,
  "(app)/request/sent": SentRoute,
  "(app)/requests/[id]": RequestStub,
};

const press = (name: string | RegExp) => fireEvent.press(screen.getByRole("button", { name }));

async function start(card: "Painting card" | "Handyman card") {
  // Home has loaded the categories before a card can be tapped.
  client.setQueryData(CATEGORIES_QUERY_KEY, [PAINTING, HANDYMAN]);
  const result = await renderRouter(routes, { initialUrl: "/" });
  await press(card);
  await waitFor(() => expect(result.getPathname()).toBe("/request/new"));
  return result;
}

/** Painting from home to Review: Ceiling, a description, the default saved address. */
async function toReview() {
  const result = await start("Painting card");
  await fireEvent.press(screen.getByRole("radio", { name: "Ceiling" }));
  await press("Continue");
  await waitFor(() => expect(result.getPathname()).toBe("/request/describe"));
  await fireEvent.changeText(screen.getByTestId("describe-text"), "Water stain on the ceiling");
  await press("Continue");
  await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
  await waitFor(() => expect(screen.getByRole("radio", { name: "Home" })).toBeChecked());
  await press("Continue");
  await waitFor(() => expect(result.getPathname()).toBe("/request/review"));
  return result;
}

const posted = () => jest.mocked(apiPost).mock.calls.map(([path, body]) => ({ path, body }));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  mockMedia.current = media();
  jest.mocked(apiGet).mockReset();
  jest
    .mocked(apiGet)
    .mockImplementation((async (path: string) =>
      path === "/v1/categories"
        ? [PAINTING, HANDYMAN]
        : { items: [HOME_ADDRESS, UNSERVED] }) as unknown as typeof apiGet);
  jest.mocked(apiPost).mockReset();
  jest.spyOn(Alert, "alert").mockReset();
});

describe("the request flow", () => {
  it("walks the steps, sends the exact request once, and gives way to the confirmation", async () => {
    await setMedia(media({ items: [photo(1)], keys: ["uploads/1.jpg"] }));
    const sending = deferred<ReturnType<typeof created>>();
    jest.mocked(apiPost).mockReturnValue(sending.promise as never);
    const result = await start("Painting card");

    expect(screen.getByRole("header", { name: "Step 1 of 4. Painting" })).toBeTruthy();
    await press("Continue");
    expect(result.getPathname()).toBe("/request/new");
    expect(screen.getByText("Answer this to continue.")).toBeTruthy();

    await fireEvent.press(screen.getByRole("radio", { name: "Ceiling" }));
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/describe"));
    expect(screen.getByRole("header", { name: "Step 2 of 4. What's going on?" })).toBeTruthy();
    await press("Continue");
    expect(screen.getByText("Tell us what's going on to continue.")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("describe-text"), "Water stain on the ceiling");
    await press("Continue");

    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Home" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "Mom's" })).toBeDisabled();
    await press("Continue");

    await waitFor(() => expect(result.getPathname()).toBe("/request/review"));
    expect(screen.getByRole("header", { name: "Step 4 of 4. Check your request" })).toBeTruthy();
    expect(screen.getByTestId("review-answer-surface")).toHaveTextContent(/Ceiling/);
    expect(screen.getByTestId("review-answer-furnished")).toHaveTextContent(/No/);
    expect(screen.getByLabelText("1 file attached")).toBeTruthy();
    expect(screen.getByTestId("review-address")).toHaveTextContent(/12 Main St, Newark, NJ 07102/);

    await press("Send request");
    await press("Send request");
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(posted()).toStrictEqual([
      {
        path: "/v1/requests",
        body: {
          category_id: PAINTING.id,
          description: "Water stain on the ceiling",
          address: {
            line1: "12 Main St",
            city: "Newark",
            state: "NJ",
            zip_code: "07102",
          },
          intake_answers: { surface: "ceiling", furnished: false },
          media_keys: ["uploads/1.jpg"],
        },
      },
    ]);

    await act(async () => sending.resolve(created()));
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    expect(screen.getByTestId("request-sent-code")).toHaveTextContent("JF-000124");
    expect(screen.getByTestId("request-sent-summary")).toHaveTextContent(
      "Painting at 12 Main St, Newark",
    );
    expect(requestDraftStore.getState().categorySlug).toBeNull();
    expect(apiPost).toHaveBeenCalledTimes(1);

    // The flow is gone from the stack: Back from the confirmation is Home.
    await act(async () => router.back());
    await waitFor(() => expect(result.getPathname()).toBe("/"));
    expect(screen.getByText("home stub")).toBeTruthy();
  });

  it("opens the sent request from the confirmation", async () => {
    jest.mocked(apiPost).mockResolvedValue(created() as never);
    const result = await toReview();

    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    await press("See my request");

    await waitFor(() => expect(result.getPathname()).toBe(`/requests/${created().id}`));
    expect(screen.getByText(`request ${created().id}`)).toBeTruthy();
  });

  it("goes back to Where with 'not in this area' on zip_not_served, then sends the new address", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(422, "zip_not_served"));
    const result = await toReview();
    const addressLoads = () =>
      jest.mocked(apiGet).mock.calls.filter(([path]) => path === "/v1/addresses").length;
    const loadsBefore = addressLoads();

    await press("Send request");

    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
    expect(screen.getByText("We're not in this area yet")).toBeTruthy();
    await waitFor(() => expect(addressLoads()).toBe(loadsBefore + 1));

    await fireEvent.press(screen.getByRole("radio", { name: "Use another address" }));
    await fireEvent.changeText(screen.getByTestId("where-line1"), "1 Broad St");
    expect(screen.queryByText("We're not in this area yet")).toBeNull();
    await fireEvent.changeText(screen.getByTestId("where-city"), "Newark");
    await fireEvent.changeText(screen.getByTestId("where-state"), "NJ");
    await fireEvent.changeText(screen.getByTestId("where-zip"), "07102");
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/review"));

    jest.mocked(apiPost).mockResolvedValueOnce(created() as never);
    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    expect(posted()[1].body).toMatchObject({
      address: { line1: "1 Broad St", city: "Newark", state: "NJ", zip_code: "07102" },
    });
  });

  it("keeps Review with Try again on a 5xx and sends again from there", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(503, undefined));
    const result = await toReview();

    await press("Send request");

    await waitFor(() => expect(screen.getByText("Your request didn't go through")).toBeTruthy());
    expect(result.getPathname()).toBe("/request/review");

    jest.mocked(apiPost).mockResolvedValueOnce(created() as never);
    await press("Try again");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it("keeps the draft across Back, and asks before discarding it", async () => {
    const result = await start("Painting card");
    await fireEvent.press(screen.getByRole("radio", { name: "Ceiling" }));
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/describe"));
    await fireEvent.changeText(screen.getByTestId("describe-text"), "Water stain");

    await press("Back");
    await waitFor(() => expect(result.getPathname()).toBe("/request/new"));
    expect(screen.getByRole("radio", { name: "Ceiling" })).toBeChecked();
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/describe"));
    expect(screen.getByTestId("describe-text").props.value).toBe("Water stain");

    // Cancel asks; "Keep editing" stays.
    await press("Cancel");
    expect(Alert.alert).toHaveBeenCalledWith(
      "Discard this request?",
      "Your answers, photos and address will be lost.",
      expect.any(Array),
    );
    const buttons = () => jest.mocked(Alert.alert).mock.lastCall?.[2] as AlertButton[];
    expect(buttons().map((button) => button.text)).toEqual(["Keep editing", "Discard"]);
    expect(result.getPathname()).toBe("/request/describe");

    // Android's back on the first step asks too; Discard leaves and forgets the draft.
    await press("Back");
    await waitFor(() => expect(result.getPathname()).toBe("/request/new"));
    await act(async () => router.back());
    expect(Alert.alert).toHaveBeenCalledTimes(2);
    expect(result.getPathname()).toBe("/request/new");
    await act(async () => buttons()[1].onPress?.());

    await waitFor(() => expect(result.getPathname()).toBe("/"));
    expect(requestDraftStore.getState()).toMatchObject({
      categorySlug: null,
      answers: {},
      description: "",
    });
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("leaves without asking when nothing was entered", async () => {
    const result = await start("Handyman card");

    expect(screen.getByRole("header", { name: "Step 1 of 3. What's going on?" })).toBeTruthy();
    await press("Back");

    await waitFor(() => expect(result.getPathname()).toBe("/"));
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("holds Continue while uploads run and goes on when they finish", async () => {
    await setMedia(media({ items: [photo(1, { status: "uploading", key: null })] }));
    const result = await start("Handyman card");
    await fireEvent.changeText(screen.getByTestId("describe-text"), "Loose cabinet door");

    await press("Continue");
    expect(result.getPathname()).toBe("/request/new");
    expect(screen.getByTestId("describe-continue")).toBeBusy();

    await setMedia(media({ items: [photo(1)], keys: ["uploads/1.jpg"] }));
    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
  });

  it("holds Continue on a failed upload until it is removed", async () => {
    const remove = jest.fn();
    const failed = photo(1, { status: "failed", key: null, failure: "failed" });
    await setMedia(media({ items: [failed], remove }));
    const result = await start("Handyman card");
    await fireEvent.changeText(screen.getByTestId("describe-text"), "Loose cabinet door");

    await press("Continue");
    expect(screen.getByText("A file didn't upload")).toBeTruthy();
    expect(result.getPathname()).toBe("/request/new");

    await press(/^Remove/);
    expect(remove).toHaveBeenCalledWith("media-1");
    await setMedia(media({ remove }));
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
  });
});
