import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Directory, File, Paths } from "expo-file-system";
import { router, useIsFocused, useScrollToTop } from "expo-router";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import {
  Alert,
  BackHandler,
  Dimensions,
  Image,
  type AlertButton,
  type AlertOptions,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useReducedMotion, withSpring, withTiming } from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";
import { createStore, useStore } from "zustand";

import {
  apiGet,
  isCurrentGeneration,
  LocalCleanupError,
  logout,
  setSessionUser,
  useSession,
  type SessionUser,
} from "@/api";
import { ID_CARD_SHARE_DIR } from "@/components/ui";
import { moveAccessibilityFocus } from "@/components/ui/focus";
import { toastStore } from "@/components/ui/toast";
import i18n from "@/i18n";

import { deferred } from "../../../api/__tests__/helpers";
import { METRICS } from "../../auth/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import { AccountScreen } from "../AccountScreen";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiConfig: { timeoutMs: 15000 },
  apiGet: jest.fn(),
  isCurrentGeneration: jest.fn(() => true),
  sessionGeneration: jest.fn(() => 1),
  setSessionUser: jest.fn(),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("@/components/ui/focus", () => ({ moveAccessibilityFocus: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true, replace: jest.fn() },
  useIsFocused: jest.fn(() => true),
  useScrollToTop: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withSpring: jest.fn(actual.withSpring),
    withTiming: jest.fn(actual.withTiming),
  };
});
// Root manual mocks (apps/mobile/__mocks__): named here so the test and the screen share one instance.
jest.mock("expo-sensors");
jest.mock("expo-haptics");
jest.mock("expo-sharing");
jest.mock("react-native-view-shot");

const HIDDEN = { includeHiddenElements: true };
/** What the root view-shot mock (apps/mobile/__mocks__) resolves a base64 capture to. */
const MOCK_CAPTURE_BASE64 = "iVBORw0KGgo=";
/** The app-private folder the shared PNGs are written to (expo-file-system's in-memory mock). */
const shareDir = () => new Directory(Paths.cache, ID_CARD_SHARE_DIR);
/** The PNGs the share left behind in the app's private cache. */
const sharedPngs = () =>
  shareDir().exists
    ? shareDir()
        .list()
        .map((entry) => entry.uri)
    : [];
const FUTURE = "2999-01-01T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";
const PHOTO = "https://media.test/id/alex.jpg?signature=1";
const FRESH_PHOTO = "https://media.test/id/alex.jpg?signature=2";

const ALEX: Partial<SessionUser> = {
  role: "pro",
  first_name: "Alex",
  last_name: "Morgan",
  home_city: "Fort Lauderdale",
  home_state: "FL",
  phone: "+19545550142",
  phone_verified: true,
  photo: { url: PHOTO, expires_at: FUTURE },
  member_since: "2026-03-14",
};
const PHONE = "+1 (954) 555-0142";
const CARD_BUTTON = "Your ID card, Alex Morgan, Fort Lauderdale, FL";
// The live card reads its phone out too (#295); the share render never does.
const FRONT_LABEL = `ID card, PRO, Alex Morgan, Fort Lauderdale, FL, ${PHONE}`;
const BACK_BUTTON = "Back to your account";
const SHARE = "Share your ID card as an image";

const tree = () => (
  <GestureHandlerRootView>
    <SafeAreaProvider initialMetrics={METRICS}>
      <AccountScreen />
    </SafeAreaProvider>
  </GestureHandlerRootView>
);
const renderAccount = () => render(tree());

/** How far the card's stage is translated down, from Reanimated's Jest style. */
const stageShift = () => {
  const style = screen.getByTestId("account-card-stage").props.jestAnimatedStyle as {
    value: { transform?: { translateY?: number }[] };
  };
  return style.value.transform?.[0]?.translateY;
};

/** The on-screen card (the share render holds a second, still one). */
const onScreenCard = () => within(screen.getByTestId("account-card", HIDDEN));
const shareCard = () => within(screen.getByTestId("account-share-render", HIDDEN));

const openCard = async () => {
  await fireEvent.press(screen.getByRole("button", { name: CARD_BUTTON }));
  await waitFor(() => expect(screen.getByRole("button", { name: BACK_BUTTON })).toBeOnTheScreen());
};

/** The share render waits for its photo; this is that photo finishing. */
const sharePhotoLoaded = () =>
  act(async () =>
    fireEvent(screen.getByTestId("account-share-render-card-photo", HIDDEN), "loadEnd"),
  );

/** The test id of the host view a screen reader was sent to (compared by id: printing a host
 * instance in a failed assertion walks the whole tree). */
const focusTarget = (call: number) => {
  const target = jest.mocked(moveAccessibilityFocus).mock.calls[call]?.[0] as
    { props?: { testID?: string }; testID?: string } | null | undefined;
  return String(target?.props?.testID ?? target?.testID ?? typeof target);
};

const busyOf = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityState as { busy?: boolean };

beforeEach(() => {
  jest.mocked(useSession).mockReturnValue(signedIn(ALEX));
  jest.mocked(useIsFocused).mockReturnValue(true);
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(logout).mockReset();
  jest.mocked(apiGet).mockReset();
  jest.mocked(setSessionUser).mockClear();
  jest.mocked(isCurrentGeneration).mockReturnValue(true);
  jest.mocked(router.push).mockClear();
  jest.mocked(moveAccessibilityFocus).mockClear();
  jest.mocked(shareAsync).mockReset().mockResolvedValue(undefined);
  jest.mocked(isAvailableAsync).mockReset().mockResolvedValue(true);
  jest.mocked(captureRef).mockClear();
  if (shareDir().exists) shareDir().delete();
  jest.mocked(withSpring).mockClear();
  jest.mocked(withTiming).mockClear();
  // getSize is overloaded (promise and callback forms), so the spy spells out the promise form.
  jest
    .spyOn(Image, "getSize")
    .mockImplementation((() =>
      Promise.resolve({ width: 960, height: 606 })) as typeof Image.getSize);
  jest.spyOn(Image, "prefetch").mockResolvedValue(true);
  // React Native's Image statics are Jest mocks already: spying again keeps their calls.
  jest.mocked(Image.getSize).mockClear();
  jest.mocked(Image.prefetch).mockClear();
  toastStore.setState({ current: null });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("AccountScreen", () => {
  it("shows the ID card from /auth/me, the member since date and the rating", async () => {
    await renderAccount();

    expect(screen.getByRole("header", { name: "Account" })).toBeOnTheScreen();
    // At rest the card is one button that names whose card it is.
    expect(screen.getByRole("button", { name: CARD_BUTTON })).toBeOnTheScreen();
    expect(screen.queryByRole("image", { name: FRONT_LABEL })).toBeNull();
    const card = onScreenCard();
    expect(card.getByText("Alex Morgan", HIDDEN)).toBeTruthy();
    expect(card.getByText("Fort Lauderdale, FL", HIDDEN)).toBeTruthy();
    expect(card.getByText("PRO", HIDDEN)).toBeTruthy();
    // The person's own number, on their own card.
    expect(card.getByText(PHONE, HIDDEN)).toBeTruthy();
    expect(card.getByTestId("account-card-photo", HIDDEN).props.source).toEqual({ uri: PHOTO });
    expect(card.getByText("K7Q2-9MXA", HIDDEN)).toBeTruthy();

    expect(screen.getByLabelText("Member since, March 2026")).toBeOnTheScreen();
    expect(screen.getByTestId("account-since")).toHaveTextContent("Member sinceMarch 2026");
    expect(screen.getByLabelText("Rating, No ratings yet")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: SHARE })).toBeOnTheScreen();
  });

  it("shows Share as a word beside the title, and as its glyph when the title would not fit", async () => {
    const jestWindow = Dimensions.get("window");
    const shareWord = () => within(screen.getByTestId("account-share")).queryByText("Share");
    try {
      await act(async () =>
        Dimensions.set({ window: { ...jestWindow, width: 320, fontScale: 1 } }),
      );
      await renderAccount();
      expect(shareWord()).toBeOnTheScreen();

      // The title wraps beside the word (a longer language, a narrower phone): the glyph it is.
      const twoLines = { nativeEvent: { lines: [{ text: "Acc" }, { text: "ount" }] } };
      await fireEvent(screen.getByTestId("account-title"), "textLayout", twoLines);
      expect(shareWord()).toBeNull();
      expect(screen.getByRole("button", { name: SHARE })).toBeOnTheScreen();

      // A large font starts from the glyph.
      await act(async () =>
        Dimensions.set({ window: { ...jestWindow, width: 320, fontScale: 1.5 } }),
      );
      expect(shareWord()).toBeNull();
    } finally {
      await act(async () => Dimensions.set({ window: jestWindow }));
    }
  });

  it("stacks the stats once a value wraps, so no word is broken, and stays stacked", async () => {
    await renderAccount();
    expect(screen.getByTestId("account-stats-divider")).toBeOnTheScreen();
    const lines = (count: number) => ({
      nativeEvent: { lines: Array.from({ length: count }, () => ({ text: "x" })) },
    });

    // One line each: side by side.
    await fireEvent(screen.getByTestId("account-since-value"), "textLayout", lines(1));
    await fireEvent(screen.getByTestId("account-rating-value"), "textLayout", lines(1));
    expect(screen.queryByTestId("account-stats-rule")).toBeNull();

    // "Aún sin calificaciones" at a large font needs two lines in a half-width column.
    await fireEvent(screen.getByTestId("account-rating-value"), "textLayout", lines(2));
    expect(screen.getByTestId("account-stats-rule")).toBeOnTheScreen();
    expect(screen.queryByTestId("account-stats-divider")).toBeNull();
    expect(screen.getByLabelText("Rating, No ratings yet")).toBeOnTheScreen();

    // Full width, the value fits again: it does not go back and forth.
    await fireEvent(screen.getByTestId("account-rating-value"), "textLayout", lines(1));
    expect(screen.getByTestId("account-stats-rule")).toBeOnTheScreen();
  });

  it("shows an older account's card gracefully: no name, no city, the silhouette", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ member_since: "2025-11-02" }));

    await renderAccount();

    expect(screen.getByRole("button", { name: "Your ID card" })).toBeOnTheScreen();
    const card = onScreenCard();
    expect(card.queryByTestId("account-card-photo", HIDDEN)).toBeNull();
    expect(card.queryByText("PRO", HIDDEN)).toBeNull();
    expect(card.queryByText(/\+1/, HIDDEN)).toBeNull();
    expect(screen.getByLabelText("Member since, November 2025")).toBeOnTheScreen();
  });

  it("brings the card forward and back: the rest moves away, Back restores it", async () => {
    await renderAccount();
    expect(screen.queryByRole("button", { name: BACK_BUTTON })).toBeNull();

    await openCard();

    expect(withSpring).toHaveBeenCalledWith(1, expect.any(Object));
    // The card is alive: its face is the button now, and turns over.
    expect(screen.getByRole("button", { name: FRONT_LABEL })).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: CARD_BUTTON })).toBeNull();
    // Everything else is out of reach.
    expect(screen.queryByRole("header", { name: "Account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.queryByLabelText("Member since, March 2026")).toBeNull();
    expect(screen.getByTestId("account-scroll").props.scrollEnabled).toBe(false);
    // A reader lands on Back once the card has arrived, and hears where it is and what to do.
    const back = screen.getByRole("button", { name: BACK_BUTTON });
    expect(back.props.accessibilityHint).toBe(
      "Your ID card is up front. Double tap the card to turn it over.",
    );
    await waitFor(() => expect(moveAccessibilityFocus).toHaveBeenCalledTimes(1));
    expect(focusTarget(0)).toBe("account-card-back");
    // Share stays where it was.
    expect(screen.getByRole("button", { name: SHARE })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: BACK_BUTTON }));

    expect(withSpring).toHaveBeenLastCalledWith(0, expect.any(Object));
    expect(screen.queryByRole("button", { name: BACK_BUTTON })).toBeNull();
    expect(screen.getByRole("button", { name: CARD_BUTTON })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Settings" })).toBeOnTheScreen();
    expect(screen.getByTestId("account-scroll").props.scrollEnabled).toBe(true);
    // And back on the card when it returns.
    await waitFor(() => expect(moveAccessibilityFocus).toHaveBeenCalledTimes(2));
    expect(focusTarget(1)).toBe("account-card-open");
  });

  it("centers the card in the free area from where it sits in the scrolled list", async () => {
    // The spring lands at once, so the style shows where the card ends up.
    const actual =
      jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
    jest.mocked(withSpring).mockImplementation(((to: number) => to) as typeof withSpring);
    try {
      await renderAccount();
      const scroll = screen.getByTestId("account-scroll");
      const layout = (height: number, y = 0) => ({
        nativeEvent: { layout: { x: 0, y, width: 320, height } },
      });
      await fireEvent(scroll, "layout", layout(552));
      await fireEvent(screen.getByTestId("account-card-stage"), "layout", layout(182, 8));
      await fireEvent.scroll(scroll, { nativeEvent: { contentOffset: { x: 0, y: 40 } } });

      await openCard();

      // Free area: 552 tall less the hint's room above the bottom inset (16 + 56); the card's
      // top lands at (552 - 72 - 182) / 2 = 149 from 8 - 40 = -32, so it travels 181.
      expect(stageShift()).toBe(181);

      // The viewport shrinks while in focus (a split screen): the card is aimed again.
      await fireEvent(scroll, "layout", layout(400));
      await act(async () => undefined);
      expect(stageShift()).toBe((400 - 72 - 182) / 2 + 32);
    } finally {
      jest.mocked(withSpring).mockImplementation(actual.withSpring);
    }
  });

  it("under Reduce Motion the card only fades out and in", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderAccount();

    await openCard();

    expect(withTiming).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ duration: 400, reduceMotion: "never" }),
    );
    expect(withSpring).not.toHaveBeenCalledWith(1, expect.any(Object));
    // The card never leans under Reduce Motion, so neither the hint nor the opener offers a tilt.
    expect(screen.getByTestId("account-card-gesture", HIDDEN)).toHaveTextContent(
      "Tap to turn it over.",
      {
        exact: true,
      },
    );
    expect(screen.getByTestId("account-card-open").props.accessibilityHint).toBe(
      "Brings the card forward so you can turn it over.",
    );
  });

  it("the Android back gesture and a second tap on the tab leave focus mode", async () => {
    const remove = jest.fn();
    const add = jest.spyOn(BackHandler, "addEventListener").mockImplementation(() => ({ remove }));
    await renderAccount();
    expect(add).not.toHaveBeenCalled();

    await openCard();
    expect(add).toHaveBeenCalledWith("hardwareBackPress", expect.any(Function));
    const onBack = add.mock.calls[0][1] as () => boolean;
    let handled = false;
    await act(async () => {
      handled = onBack();
    });
    expect(handled).toBe(true);
    expect(screen.queryByRole("button", { name: BACK_BUTTON })).toBeNull();
    expect(remove).toHaveBeenCalled();

    await openCard();
    const tab = jest.mocked(useScrollToTop).mock.calls.at(-1)?.[0] as unknown as {
      current: { scrollToTop: () => void };
    };
    await act(async () => tab.current.scrollToTop());
    expect(screen.queryByRole("button", { name: BACK_BUTTON })).toBeNull();
    expect(screen.getByRole("button", { name: CARD_BUTTON })).toBeOnTheScreen();
  });

  it.each([
    ["Settings", "/settings"],
    ["Help", "/help"],
    ["Legal", "/legal"],
  ])("the %s row opens its screen", async (name, href) => {
    await renderAccount();

    await fireEvent.press(screen.getByRole("button", { name }));

    expect(router.push).toHaveBeenCalledWith(href);
  });

  it("log out asks first, then signs out with the row busy", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const pending = deferred<void>();
    jest.mocked(logout).mockReturnValue(pending.promise);
    await renderAccount();

    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));

    expect(logout).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      "Log out?",
      "You can log back in anytime with your email and password.",
      expect.any(Array),
      expect.objectContaining({ cancelable: true }),
    );
    const buttons = alert.mock.calls[0][2] as AlertButton[];
    expect(buttons.map(({ text, style }) => [text, style])).toEqual([
      ["Cancel", "cancel"],
      ["Log out", "destructive"],
    ]);
    // A second tap while the question is up asks nothing more; once answered, it asks again.
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));
    expect(alert).toHaveBeenCalledTimes(1);
    await act(async () => buttons[0].onPress?.());
    expect(logout).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));
    expect(alert).toHaveBeenCalledTimes(2);
    // Android's back closes it like Cancel: it asks again next time.
    await act(async () => (alert.mock.calls[1][3] as AlertOptions).onDismiss?.());
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));
    expect(alert).toHaveBeenCalledTimes(3);

    await act(async () => buttons[1].onPress?.());

    expect(logout).toHaveBeenCalledTimes(1);
    expect(busyOf("Log out")).toMatchObject({ busy: true, disabled: true });
    pending.resolve();
    await waitFor(() => expect(busyOf("Log out")).toMatchObject({ busy: false }));
  });

  it("a failed local delete on log out is handled: no throw, no error here", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    jest.mocked(logout).mockRejectedValue(new LocalCleanupError());
    await renderAccount();

    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));
    await act(async () => (alert.mock.calls[0][2] as AlertButton[])[1].onPress?.());

    await waitFor(() => expect(busyOf("Log out")).toMatchObject({ busy: false }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shares the card as a still PNG without the phone, once per tap", async () => {
    await renderAccount();
    // The still render: the name, the city and state, the code; never the phone.
    expect(shareCard().getByText("Alex Morgan", HIDDEN)).toBeTruthy();
    expect(shareCard().getByText("Fort Lauderdale, FL", HIDDEN)).toBeTruthy();
    expect(shareCard().queryByText(PHONE, HIDDEN)).toBeNull();
    expect(shareCard().getByTestId("account-share-render-card-photo", HIDDEN).props.source).toEqual(
      { uri: PHOTO },
    );
    await sharePhotoLoaded();
    // The sheet stays open until the person picks an app or closes it.
    const sheet = deferred<void>();
    jest.mocked(shareAsync).mockReturnValue(sheet.promise);

    await fireEvent.press(screen.getByRole("button", { name: SHARE }));
    await waitFor(() => expect(shareAsync).toHaveBeenCalledTimes(1));
    expect(busyOf(`${SHARE}, Loading`)).toMatchObject({ busy: true });
    // A second tap while the sheet is up opens nothing more.
    await fireEvent.press(screen.getByTestId("account-share"));

    expect(shareAsync).toHaveBeenCalledTimes(1);
    expect(shareAsync).toHaveBeenCalledWith(expect.any(String), {
      mimeType: "image/png",
      UTI: "public.png",
      dialogTitle: "Share your ID card",
    });
    // While the sheet is up the PNG is there, and only there; it is gone once the sheet closes.
    const [shared = ""] = jest.mocked(shareAsync).mock.calls[0] ?? [];
    expect(sharedPngs()).toEqual([shared]);
    await expect(new File(shared).base64()).resolves.toBe(MOCK_CAPTURE_BASE64);
    sheet.resolve();
    await waitFor(() => expect(busyOf(SHARE)).toMatchObject({ busy: false }));
    expect(sharedPngs()).toEqual([]);
    expect(toastStore.getState().current).toBeNull();
  });

  it("writes the PNG into the app's private cache itself: view-shot never picks a folder", async () => {
    // view-shot's own temporary file can land in Android's external cache, which other apps can
    // read before Android 10 (#293): the capture must come back as pixels, never as a file.
    await renderAccount();
    await sharePhotoLoaded();
    await fireEvent.press(screen.getByRole("button", { name: SHARE }));
    await waitFor(() => expect(shareAsync).toHaveBeenCalledTimes(1));

    expect(captureRef).toHaveBeenCalledTimes(1);
    expect(jest.mocked(captureRef).mock.calls[0]?.[1]).toMatchObject({ result: "base64" });
    const [shared = ""] = jest.mocked(shareAsync).mock.calls[0] ?? [];
    expect(shared.startsWith(`${Paths.cache.uri}${ID_CARD_SHARE_DIR}/`)).toBe(true);
    await waitFor(() => expect(sharedPngs()).toEqual([]));
  });

  it.each([
    ["the share sheet fails", () => jest.mocked(shareAsync).mockRejectedValue(new Error("x"))],
    ["there is no share sheet", () => jest.mocked(isAvailableAsync).mockResolvedValue(false)],
  ])("a share that cannot finish (%s) says so calmly", async (_, arrange) => {
    arrange();
    await renderAccount();
    await sharePhotoLoaded();

    await fireEvent.press(screen.getByRole("button", { name: SHARE }));

    await waitFor(() =>
      expect(toastStore.getState().current).toMatchObject({
        message: "We couldn't share your ID card. Give it another try in a moment.",
        tone: "neutral",
      }),
    );
    await waitFor(() => expect(busyOf(SHARE)).toMatchObject({ busy: false }));
    expect(sharedPngs()).toEqual([]);
  });

  describe("a share belongs to the signed-in screen that started it", () => {
    /** Share pressed with the photo loaded; native capture done, its size read held open. */
    const shareHeldAtCapture = async () => {
      const size = deferred<{ width: number; height: number }>();
      jest
        .mocked(Image.getSize)
        .mockImplementationOnce((() => size.promise) as typeof Image.getSize);
      const view = await renderAccount();
      await sharePhotoLoaded();
      await fireEvent.press(screen.getByRole("button", { name: SHARE }));
      await waitFor(() => expect(Image.getSize).toHaveBeenCalled());
      expect(shareAsync).not.toHaveBeenCalled();
      return { view, size };
    };

    it("never opens the previous account's sheet when the capture finishes after log out", async () => {
      const { view, size } = await shareHeldAtCapture();
      // Log out: the session generation moves on and SessionGate unmounts Account.
      jest.mocked(isCurrentGeneration).mockReturnValue(false);
      await view.unmount();
      await act(async () => size.resolve({ width: 960, height: 606 }));

      expect(shareAsync).not.toHaveBeenCalled();
      expect(toastStore.getState().current).toBeNull();
      expect(sharedPngs()).toEqual([]);
    });

    it("writes nothing when the native capture itself answers after log out", async () => {
      const pixels = deferred<string>();
      jest.mocked(captureRef).mockReturnValueOnce(pixels.promise);
      const view = await renderAccount();
      await sharePhotoLoaded();
      await fireEvent.press(screen.getByRole("button", { name: SHARE }));
      await waitFor(() => expect(captureRef).toHaveBeenCalledTimes(1));
      jest.mocked(isCurrentGeneration).mockReturnValue(false);
      await view.unmount();
      await act(async () => pixels.resolve(MOCK_CAPTURE_BASE64));

      expect(shareAsync).not.toHaveBeenCalled();
      expect(toastStore.getState().current).toBeNull();
      expect(sharedPngs()).toEqual([]);
    });

    it.each([
      [
        "finishes",
        (size: ReturnType<typeof deferred<{ width: number; height: number }>>) =>
          size.resolve({ width: 960, height: 606 }),
      ],
      [
        "fails",
        (size: ReturnType<typeof deferred<{ width: number; height: number }>>) =>
          size.reject(new Error("capture failed")),
      ],
    ])("a capture that %s after the session changed ends silently", async (_, settle) => {
      const { size } = await shareHeldAtCapture();
      jest.mocked(isCurrentGeneration).mockReturnValue(false);
      await act(async () => settle(size));

      expect(shareAsync).not.toHaveBeenCalled();
      expect(toastStore.getState().current).toBeNull();
      await waitFor(() => expect(busyOf(SHARE)).toMatchObject({ busy: false }));
      // The PNG was written before its size was read: an unused one is deleted.
      expect(sharedPngs()).toEqual([]);
    });

    it("opens no sheet when the capture finishes after the screen went away", async () => {
      const { view, size } = await shareHeldAtCapture();
      expect(sharedPngs()).toHaveLength(1);
      await view.unmount();
      await act(async () => size.resolve({ width: 960, height: 606 }));

      expect(shareAsync).not.toHaveBeenCalled();
      expect(toastStore.getState().current).toBeNull();
      expect(sharedPngs()).toEqual([]);
    });

    it("shows no toast when log out cancels a share still waiting for the photo", async () => {
      const view = await renderAccount();
      await fireEvent.press(screen.getByRole("button", { name: SHARE }));
      await act(async () => undefined);
      jest.mocked(isCurrentGeneration).mockReturnValue(false);
      // Unmounting the share render rejects its photo waiter.
      await view.unmount();
      await act(async () => undefined);

      expect(shareAsync).not.toHaveBeenCalled();
      expect(toastStore.getState().current).toBeNull();
      expect(captureRef).not.toHaveBeenCalled();
      expect(sharedPngs()).toEqual([]);
    });

    it("keeps a photo refresh that finishes after the session changed out of the session", async () => {
      const prefetch = deferred<boolean>();
      jest.mocked(Image.prefetch).mockReturnValue(prefetch.promise);
      const fresh = { ...signedIn(ALEX).user, photo: { url: FRESH_PHOTO, expires_at: FUTURE } };
      jest.mocked(apiGet).mockResolvedValue(fresh as never);
      jest
        .mocked(useSession)
        .mockReturnValue(signedIn({ ...ALEX, photo: { url: PHOTO, expires_at: PAST } }));
      await renderAccount();
      await waitFor(() => expect(Image.prefetch).toHaveBeenCalledWith(FRESH_PHOTO));
      jest.mocked(isCurrentGeneration).mockReturnValue(false);
      await act(async () => prefetch.resolve(true));

      expect(setSessionUser).not.toHaveBeenCalled();
    });

    it("keeps a photo refresh that answers after unmount out of the session", async () => {
      const response = deferred<SessionUser>();
      jest.mocked(apiGet).mockReturnValue(response.promise as never);
      jest
        .mocked(useSession)
        .mockReturnValue(signedIn({ ...ALEX, photo: { url: PHOTO, expires_at: PAST } }));
      const view = await renderAccount();
      await waitFor(() => expect(apiGet).toHaveBeenCalled());
      // A transport that ignores the abort still answers.
      await view.unmount();
      await act(async () =>
        response.resolve({ ...signedIn(ALEX).user, photo: null } as SessionUser),
      );

      expect(setSessionUser).not.toHaveBeenCalled();
    });
  });

  it("asks for a fresh photo URL when the one it has expired, and swaps it in once cached", async () => {
    const fresh = { ...signedIn(ALEX).user, photo: { url: FRESH_PHOTO, expires_at: FUTURE } };
    jest.mocked(apiGet).mockResolvedValue(fresh as never);
    jest
      .mocked(useSession)
      .mockReturnValue(signedIn({ ...ALEX, photo: { url: PHOTO, expires_at: PAST } }));

    await renderAccount();

    await waitFor(() => expect(setSessionUser).toHaveBeenCalledWith(fresh));
    expect(apiGet).toHaveBeenCalledWith("/v1/auth/me", expect.objectContaining({ auth: true }));
    expect(Image.prefetch).toHaveBeenCalledWith(FRESH_PHOTO);
    const prefetched = jest.mocked(Image.prefetch).mock.invocationCallOrder[0];
    expect(prefetched).toBeLessThan(jest.mocked(setSessionUser).mock.invocationCallOrder[0]);
  });

  it("leaves a valid photo URL alone, and an expired one quietly when the refresh fails", async () => {
    const view = await renderAccount();
    expect(apiGet).not.toHaveBeenCalled();
    await view.unmount();

    jest.mocked(apiGet).mockRejectedValue(new Error("offline"));
    jest
      .mocked(useSession)
      .mockReturnValue(signedIn({ ...ALEX, photo: { url: PHOTO, expires_at: PAST } }));
    await renderAccount();

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(setSessionUser).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: CARD_BUTTON })).toBeOnTheScreen();
  });

  it("refreshes at most once per focus: a clock ahead of the server never loops", async () => {
    // Every answer looks expired to this device, and the session really takes it.
    const store = createStore(() => signedIn({ ...ALEX, photo: { url: PHOTO, expires_at: PAST } }));
    jest.mocked(useSession).mockImplementation(() => useStore(store));
    jest.mocked(setSessionUser).mockImplementation((user) => store.setState({ user }));
    const stale = {
      ...store.getState().user,
      photo: { url: FRESH_PHOTO, expires_at: "2000-01-02T00:00:00Z" },
    };
    jest.mocked(apiGet).mockResolvedValue(stale as never);
    const view = await renderAccount();

    await waitFor(() => expect(setSessionUser).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(apiGet).toHaveBeenCalledTimes(1);

    // The next visit to the tab tries once more.
    jest.mocked(useIsFocused).mockReturnValue(false);
    await view.rerender(tree());
    jest.mocked(useIsFocused).mockReturnValue(true);
    await view.rerender(tree());
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("treats a URL about to expire as expired", async () => {
    const soon = new Date(Date.now() + 10_000).toISOString();
    jest.mocked(apiGet).mockReturnValue(new Promise(() => undefined));
    jest
      .mocked(useSession)
      .mockReturnValue(signedIn({ ...ALEX, photo: { url: PHOTO, expires_at: soon } }));

    await renderAccount();

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
  });

  it("does not refresh while the tab is not the one showing", async () => {
    jest.mocked(useIsFocused).mockReturnValue(false);
    jest
      .mocked(useSession)
      .mockReturnValue(signedIn({ ...ALEX, photo: { url: PHOTO, expires_at: PAST } }));

    await renderAccount();
    await act(async () => undefined);

    expect(apiGet).not.toHaveBeenCalled();
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");

    await renderAccount();

    expect(screen.getByRole("header", { name: "Cuenta" })).toBeOnTheScreen();
    expect(
      screen.getByRole("button", {
        name: "Tu tarjeta de identificación, Alex Morgan, Fort Lauderdale, FL",
      }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText("Miembro desde, marzo de 2026")).toBeOnTheScreen();
    expect(screen.getByLabelText("Calificación, Aún sin calificaciones")).toBeOnTheScreen();
    for (const name of ["Configuración", "Ayuda", "Legal", "Cerrar sesión"]) {
      expect(screen.getByRole("button", { name })).toBeOnTheScreen();
    }
    expect(
      screen.getByRole("button", { name: "Compartir tu tarjeta de identificación como imagen" }),
    ).toBeOnTheScreen();
  });
});
