import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { createElement } from "react";
import {
  AccessibilityInfo,
  Alert,
  BackHandler,
  Platform,
  Pressable,
  Text,
  type AlertButton,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ApiError, apiGet, apiPost, type SessionUser } from "@/api";
import type { MediaItem, MediaUpload } from "@/features/media";

import { user } from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import DescribeRoute from "../../../app/(app)/request/(flow)/describe";
import FlowLayout from "../../../app/(app)/request/(flow)/_layout";
import NewRoute from "../../../app/(app)/request/(flow)/new";
import ReviewRoute from "../../../app/(app)/request/(flow)/review";
import WhenRoute from "../../../app/(app)/request/(flow)/when";
import WhereRoute from "../../../app/(app)/request/(flow)/where";
import SentRoute from "../../../app/(app)/request/sent";
import { METRICS } from "../../auth/__tests__/helpers";
import { panelRiseOptions } from "../../auth/panelRoute";
import { CATEGORIES_QUERY_KEY } from "../../home/useCategories";
import { TabsLayout } from "../../tabs/TabsLayout";
import { formatLongDay, offeredDays } from "../dates";
import { requestDraftStore, startRequest } from "../requestDraft";
import { requestFlowOptions } from "../rise";
import { created, HANDYMAN, PAINTING, savedAddress } from "./helpers";

const mockSignedIn: { status: "signedIn"; user: SessionUser } = { status: "signedIn", user };
// The session generation: a test moves it on to stand for a sign-out landing mid-send.
const mockGeneration = { current: 1 };
const OTHER_ACCOUNT: SessionUser = {
  ...user,
  id: "22222222-2222-4222-8222-222222222222",
  email: "ben@example.com",
};

// The flow's upload list, changed by a test inside `act` (an upload finishing, failing, removed).
const mockMedia: { current: MediaUpload | null; listeners: Set<() => void> } = {
  current: null,
  listeners: new Set(),
};

jest.mock("@/api", () => {
  // What the flow registers to forget at a sign-out (at import, before this file's own consts).
  const forgetters = new Set<() => void>();
  return {
    ...jest.requireActual("../../../api/errors"),
    onSignOut: (forget: () => void) => forgetters.add(forget),
    mockSignOut: () => forgetters.forEach((forget) => forget()),
    apiGet: jest.fn(),
    apiPost: jest.fn(),
    useSession: () => mockSignedIn,
    sessionGeneration: () => mockGeneration.current,
    isCurrentGeneration: (startedIn: number) => startedIn === mockGeneration.current,
  };
});
/** Forgets what the flow keeps of the session, as a sign-out does: each test starts after one. */
const signOut = () => jest.requireMock<{ mockSignOut: () => void }>("@/api").mockSignOut();
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
/** How many times screen readers were told something containing `text`, by either announce API. */
function spoken(text: string): number {
  return [
    ...jest.mocked(AccessibilityInfo.announceForAccessibility).mock.calls,
    ...jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls,
  ].filter(([message]) => message.includes(text)).length;
}

let announceSpies: jest.SpyInstance[] = [];

beforeEach(() => {
  announceSpies = [
    jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(),
    jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions").mockImplementation(),
  ];
});

afterEach(() => announceSpies.forEach((spy) => spy.mockRestore()));

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

/** The first step's risen wrapper, while it shows. */
const risenStep = () =>
  screen.getByTestId("request-questions-risen", { includeHiddenElements: true });

/** Opens the request as Home's categories panel does: risen, the panel's push. */
const openRisen = (slug: string) =>
  startRequest(slug, (href) => {
    router.push(href);
    return true;
  });

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
  "(app)/request/(flow)/when": WhenRoute,
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

/** From Where's Continue, on through When ("I'm flexible", its default) to Review. */
async function throughWhen(result: Awaited<ReturnType<typeof renderRouter>>) {
  await waitFor(() => expect(result.getPathname()).toBe("/request/when"));
  await press("Continue");
  await waitFor(() => expect(result.getPathname()).toBe("/request/review"));
}

/** Painting from home to Review: Ceiling, a description, the default saved address, any day. */
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
  await throughWhen(result);
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
  mockSignedIn.user = user;
  mockGeneration.current = 1;
  signOut();
});

describe("the request flow", () => {
  it("walks the steps, sends the exact request once, and gives way to the confirmation", async () => {
    await setMedia(media({ items: [photo(1)], keys: ["uploads/1.jpg"] }));
    const sending = deferred<ReturnType<typeof created>>();
    jest.mocked(apiPost).mockReturnValue(sending.promise as never);
    const result = await start("Painting card");

    expect(screen.getByRole("header", { name: "Step 1 of 5. Painting" })).toBeTruthy();
    await press("Continue");
    expect(result.getPathname()).toBe("/request/new");
    expect(screen.getByText("Answer this to continue.")).toBeTruthy();

    await fireEvent.press(screen.getByRole("radio", { name: "Ceiling" }));
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/describe"));
    expect(screen.getByRole("header", { name: "Step 2 of 5. What's going on?" })).toBeTruthy();
    await press("Continue");
    expect(screen.getByText("Tell us what's going on to continue.")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("describe-text"), "Water stain on the ceiling");
    await press("Continue");

    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Home" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "Mom's" })).toBeDisabled();
    await press("Continue");

    await waitFor(() => expect(result.getPathname()).toBe("/request/when"));
    expect(screen.getByRole("header", { name: "Step 4 of 5. When works for you?" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "I'm flexible" })).toBeChecked();
    const day = offeredDays(2)[1];
    await fireEvent.press(screen.getByTestId(`when-day-${day}`));
    expect(screen.getByTestId(`when-day-${day}`)).toBeChecked();
    expect(screen.getByRole("radio", { name: "I'm flexible" })).not.toBeChecked();
    expect(screen.getByTestId("when-chosen")).toHaveTextContent(formatLongDay(day, "en"));
    await press("Continue");

    await waitFor(() => expect(result.getPathname()).toBe("/request/review"));
    expect(screen.getByRole("header", { name: "Step 5 of 5. Check your request" })).toBeTruthy();
    expect(screen.getByTestId("review-answer-surface")).toHaveTextContent(/Ceiling/);
    expect(screen.getByTestId("review-answer-furnished")).toHaveTextContent(/No/);
    expect(screen.getByLabelText("1 file attached")).toBeTruthy();
    expect(screen.getByTestId("review-address")).toHaveTextContent(/12 Main St, Newark, NJ 07102/);
    expect(screen.getByTestId("review-when")).toHaveTextContent(
      new RegExp(formatLongDay(day, "en")),
    );

    await press("Send request");
    await press("Send request");
    expect(apiPost).toHaveBeenCalledTimes(1);
    // In flight, the request cannot change or be left: it may already exist on the server.
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit the address" })).toBeDisabled();
    await act(async () => router.back());
    expect(result.getPathname()).toBe("/request/review");
    expect(Alert.alert).not.toHaveBeenCalled();
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
          preferred_date: day,
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

  it("shows the confirmation only to the account that sent it", async () => {
    jest.mocked(apiPost).mockResolvedValue(created() as never);
    const result = await toReview();
    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    await press("Back to Home");
    await waitFor(() => expect(result.getPathname()).toBe("/"));

    // Another account on the same running app follows the confirmation's link.
    mockSignedIn.user = OTHER_ACCOUNT;
    await act(async () => router.push({ pathname: "/request/sent", params: { id: created().id } }));

    await waitFor(() => expect(result.getPathname()).toBe(`/requests/${created().id}`));
    expect(screen.getByText(`request ${created().id}`)).toBeTruthy();
    expect(screen.queryByText("JF-000124")).toBeNull();
    expect(screen.queryByText(/12 Main St/)).toBeNull();
  });

  it("drops an answer that lands after the session it was sent in ended", async () => {
    const sending = deferred<ReturnType<typeof created>>();
    jest.mocked(apiPost).mockReturnValue(sending.promise as never);
    const result = await toReview();
    await press("Send request");

    // The sign-out lands between the client's own session check and the flow's callback.
    mockGeneration.current = 2;
    await act(async () => sending.resolve(created()));

    expect(result.getPathname()).toBe("/request/review");
    await act(async () => router.push({ pathname: "/request/sent", params: { id: created().id } }));
    await waitFor(() => expect(result.getPathname()).toBe(`/requests/${created().id}`));
    expect(screen.queryByText("JF-000124")).toBeNull();
  });

  it("takes a street, unit and city as long as the API does and refuses longer ones inline", async () => {
    const result = await toReview();
    await press("Edit the address");
    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
    await fireEvent.press(screen.getByRole("radio", { name: "Use another address" }));
    const field = (testID: string) => screen.getByTestId(testID);
    expect(field("where-line1").props.maxLength).toBe(255);
    expect(field("where-line2").props.maxLength).toBe(255);
    expect(field("where-city").props.maxLength).toBe(128);

    // What gets past a field's own limit (an autofill, a paste on some keyboards) meets the check.
    await fireEvent.changeText(field("where-line1"), "a".repeat(256));
    await fireEvent.changeText(field("where-line2"), "b".repeat(256));
    await fireEvent.changeText(field("where-city"), "c".repeat(129));
    await fireEvent.changeText(field("where-state"), "NJ");
    await fireEvent.changeText(field("where-zip"), "07102");
    await press("Continue");

    expect(result.getPathname()).toBe("/request/where");
    expect(field("where-line1").props.accessibilityHint).toBe(
      "Keep it to 255 characters or fewer.",
    );
    expect(field("where-line2").props.accessibilityHint).toBe(
      "Keep it to 255 characters or fewer.",
    );
    expect(field("where-city").props.accessibilityHint).toBe("Keep it to 128 characters or fewer.");

    await fireEvent.changeText(field("where-line1"), "a".repeat(255));
    await fireEvent.changeText(field("where-line2"), "b".repeat(255));
    await fireEvent.changeText(field("where-city"), "c".repeat(128));
    expect(field("where-line1").props.accessibilityHint).toBeUndefined();
    await press("Continue");
    await throughWhen(result);

    jest.mocked(apiPost).mockResolvedValueOnce(created() as never);
    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    expect(posted()[0].body).toMatchObject({
      address: { line1: "a".repeat(255), line2: "b".repeat(255), city: "c".repeat(128) },
    });
  });

  it("goes back to Where with the field marked when the API refuses the typed address", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(422, "validation_error"));
    const result = await toReview();
    // A typed address the form's check would refuse reaches Review (the check and the API's rules
    // drifting apart, say). The API's validation_error names no field.
    await act(async () =>
      requestDraftStore.setState({
        address: { kind: "typed" },
        typedAddress: {
          line1: "a".repeat(256),
          line2: "",
          city: "Newark",
          state: "NJ",
          zipCode: "07102",
        },
      }),
    );

    await press("Send request");

    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
    expect(screen.getByText("Check the address")).toBeTruthy();
    await waitFor(() => expect(spoken("Check the address")).toBe(1));
    const line1 = screen.getByTestId("where-line1");
    expect(line1.props.accessibilityHint).toBe("Keep it to 255 characters or fewer.");
    expect(screen.getByTestId("where-city").props.accessibilityHint).toBeUndefined();

    await fireEvent.changeText(line1, "1 Broad St");
    expect(screen.queryByText("Check the address")).toBeNull();
    await press("Continue");
    await throughWhen(result);

    jest.mocked(apiPost).mockResolvedValueOnce(created() as never);
    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    expect(posted()[1].body).toMatchObject({ address: { line1: "1 Broad St", city: "Newark" } });
  });

  it("keeps a validation_error on Review when the address passes the form's check", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(422, "validation_error"));
    const result = await toReview();

    await press("Send request");

    await waitFor(() => expect(screen.getByText("We couldn't send this request")).toBeTruthy());
    expect(result.getPathname()).toBe("/request/review");
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
    await waitFor(() => expect(spoken("We're not in this area yet")).toBe(1)); // the notice's own
    await waitFor(() => expect(addressLoads()).toBe(loadsBefore + 1));

    await fireEvent.press(screen.getByRole("radio", { name: "Use another address" }));
    await fireEvent.changeText(screen.getByTestId("where-line1"), "1 Broad St");
    expect(screen.queryByText("We're not in this area yet")).toBeNull();
    await fireEvent.changeText(screen.getByTestId("where-city"), "Newark");
    await fireEvent.changeText(screen.getByTestId("where-state"), "NJ");
    await fireEvent.changeText(screen.getByTestId("where-zip"), "07102");
    await press("Continue");
    await throughWhen(result);

    jest.mocked(apiPost).mockResolvedValueOnce(created() as never);
    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    expect(posted()[1].body).toMatchObject({
      address: { line1: "1 Broad St", city: "Newark", state: "NJ", zip_code: "07102" },
    });
  });

  it("announces a second refusal for the same reason again, once", async () => {
    jest
      .mocked(apiPost)
      .mockRejectedValueOnce(new ApiError(422, "zip_not_served"))
      .mockRejectedValueOnce(new ApiError(422, "zip_not_served"));
    const result = await toReview();

    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
    await waitFor(() => expect(spoken("We're not in this area yet")).toBe(1));

    await press("Continue"); // same address: the notice stays on Where
    await throughWhen(result);
    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
    await waitFor(() => expect(spoken("We're not in this area yet")).toBe(2));
  });

  it("keeps Review with Try again on a 5xx and sends again from there", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(503, undefined));
    const result = await toReview();

    await press("Send request");

    await waitFor(() => expect(screen.getByText("Your request didn't go through")).toBeTruthy());
    expect(result.getPathname()).toBe("/request/review");
    expect(spoken("Your request didn't go through")).toBe(1);

    jest.mocked(apiPost).mockResolvedValueOnce(created() as never);
    await press("Try again");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it("sends a day gone by back to When, where flexible clears it", async () => {
    const result = await toReview();
    expect(screen.getByTestId("review-when")).toHaveTextContent(/I'm flexible: any day works/);
    // The customer picked a day before midnight; it has passed since.
    await act(async () => requestDraftStore.setState({ preferredDate: "2020-01-01" }));

    await press("Send request");

    await waitFor(() => expect(result.getPathname()).toBe("/request/when"));
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText("That day has passed")).toBeTruthy();
    await waitFor(() => expect(spoken("That day has passed")).toBe(1));
    expect(screen.queryByTestId("when-chosen")).toBeNull();

    await fireEvent.press(screen.getByRole("radio", { name: "I'm flexible" }));
    expect(screen.queryByText("That day has passed")).toBeNull();
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/review"));
    jest.mocked(apiPost).mockResolvedValueOnce(created() as never);
    await press("Send request");
    await waitFor(() => expect(result.getPathname()).toBe("/request/sent"));
    expect(posted()[0].body).not.toHaveProperty("preferred_date");
  });

  it("edits the day from Review and keeps it across Back", async () => {
    const result = await toReview();
    await press("Edit the day");
    await waitFor(() => expect(result.getPathname()).toBe("/request/when"));
    const day = offeredDays(3)[2];
    await fireEvent.press(screen.getByTestId(`when-day-${day}`));
    await press("Back");
    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/when"));
    expect(screen.getByTestId(`when-day-${day}`)).toBeChecked();
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/review"));
    expect(screen.getByTestId("review-when")).toHaveTextContent(
      new RegExp(formatLongDay(day, "en")),
    );
  });

  it("gives the flow the panel rise when a category card opens it, the push otherwise", async () => {
    client.setQueryData(CATEGORIES_QUERY_KEY, [PAINTING, HANDYMAN]);
    const result = await renderRouter(routes, { initialUrl: "/" });

    await act(async () => openRisen("painting"));
    await waitFor(() => expect(result.getPathname()).toBe("/request/new"));
    expect(requestFlowOptions()).toEqual(panelRiseOptions(Platform.OS));
    expect(requestFlowOptions()).not.toEqual({ animation: "default" });
    // In on its own: no panel rose under it here, so the entrance's fail-safe brings it in.
    await waitFor(() => expect(risenStep().props.pointerEvents).toBe("auto"), { timeout: 3000 });

    await press("Back");
    await waitFor(() => expect(result.getPathname()).toBe("/"), { timeout: 3000 });
    await press("Painting card"); // a plain push
    await waitFor(() => expect(result.getPathname()).toBe("/request/new"));
    expect(requestFlowOptions()).toEqual({ animation: "default" });
    expect(
      screen.queryByTestId("request-questions-risen", { includeHiddenElements: true }),
    ).toBeNull();
  });

  it("asks before discarding a risen draft too, and fades out onto the panel on Back or Android's back", async () => {
    const backHandlers = jest.spyOn(BackHandler, "addEventListener");
    client.setQueryData(CATEGORIES_QUERY_KEY, [PAINTING, HANDYMAN]);
    const result = await renderRouter(routes, { initialUrl: "/" });
    await act(async () => openRisen("painting"));
    await waitFor(() => expect(result.getPathname()).toBe("/request/new"));
    await waitFor(() => expect(risenStep().props.pointerEvents).toBe("auto"), { timeout: 3000 });
    await fireEvent.press(screen.getByRole("radio", { name: "Ceiling" }));

    // Android's back runs through the flow's close: the draft asks first.
    const [, onBack] = backHandlers.mock.calls.at(-1) as [string, () => boolean];
    let handled = false;
    await act(async () => {
      handled = onBack();
    });
    expect(handled).toBe(true);
    const buttons = () => jest.mocked(Alert.alert).mock.lastCall?.[2] as AlertButton[];
    expect(buttons().map((button) => button.text)).toEqual(["Keep editing", "Discard"]);
    expect(result.getPathname()).toBe("/request/new");

    await press("Back"); // the Back button asks the same
    expect(Alert.alert).toHaveBeenCalledTimes(2);
    await act(async () => buttons()[1].onPress?.());
    // The step fades out onto the panel, then the flow goes (and Home lowers its panel).
    await waitFor(() => expect(result.getPathname()).toBe("/"), { timeout: 3000 });
    expect(requestDraftStore.getState().categorySlug).toBeNull();
    backHandlers.mockRestore();
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

    expect(screen.getByRole("header", { name: "Step 1 of 4. What's going on?" })).toBeTruthy();
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

  it("checks the description again when the uploads settle", async () => {
    await setMedia(media({ items: [photo(1, { status: "uploading", key: null })] }));
    const result = await start("Handyman card");
    await fireEvent.changeText(screen.getByTestId("describe-text"), "Loose cabinet door");
    await press("Continue");

    await fireEvent.changeText(screen.getByTestId("describe-text"), "");
    await setMedia(media({ items: [photo(1)], keys: ["uploads/1.jpg"] }));

    expect(await screen.findByText("Tell us what's going on to continue.")).toBeTruthy();
    expect(result.getPathname()).toBe("/request/new");
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
    expect(spoken("A file didn't upload")).toBe(1);
    await press("Continue"); // pressed again while it shows: said again
    expect(spoken("A file didn't upload")).toBe(2);

    await press(/^Remove/);
    expect(remove).toHaveBeenCalledWith("media-1");
    await setMedia(media({ remove }));
    await press("Continue");
    await waitFor(() => expect(result.getPathname()).toBe("/request/where"));
  });
});
