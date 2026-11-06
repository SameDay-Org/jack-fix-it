import "@/i18n";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { router, useIsFocused, useScrollToTop } from "expo-router";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { Alert, BackHandler, Image, type AlertButton } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useReducedMotion, withSpring, withTiming } from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MOCK_CAPTURE_URI } from "react-native-view-shot";

import {
  apiGet,
  LocalCleanupError,
  logout,
  setSessionUser,
  useSession,
  type SessionUser,
} from "@/api";
import { announce, moveAccessibilityFocus } from "@/components/ui/focus";
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
jest.mock("@/components/ui/focus", () => ({
  announce: jest.fn(),
  moveAccessibilityFocus: jest.fn(),
}));
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
const FRONT_LABEL = "ID card, PRO, Alex Morgan, Fort Lauderdale, FL";
const BACK_BUTTON = "Back to your account";
const SHARE = "Share your ID card as an image";

const renderAccount = () =>
  render(
    <GestureHandlerRootView>
      <SafeAreaProvider initialMetrics={METRICS}>
        <AccountScreen />
      </SafeAreaProvider>
    </GestureHandlerRootView>,
  );

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

const busyOf = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityState as { busy?: boolean };

beforeEach(() => {
  jest.mocked(useSession).mockReturnValue(signedIn(ALEX));
  jest.mocked(useIsFocused).mockReturnValue(true);
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(logout).mockReset();
  jest.mocked(apiGet).mockReset();
  jest.mocked(setSessionUser).mockClear();
  jest.mocked(router.push).mockClear();
  jest.mocked(announce).mockClear();
  jest.mocked(moveAccessibilityFocus).mockClear();
  jest.mocked(shareAsync).mockReset().mockResolvedValue(undefined);
  jest.mocked(isAvailableAsync).mockReset().mockResolvedValue(true);
  jest.mocked(withSpring).mockClear();
  jest.mocked(withTiming).mockClear();
  // getSize is overloaded (promise and callback forms), so the spy spells out the promise form.
  jest
    .spyOn(Image, "getSize")
    .mockImplementation((() =>
      Promise.resolve({ width: 960, height: 606 })) as typeof Image.getSize);
  jest.spyOn(Image, "prefetch").mockResolvedValue(true);
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
    expect(announce).toHaveBeenCalledWith(
      "Your ID card is up front. Drag to tilt it, tap to turn it over.",
    );
    await waitFor(() => expect(moveAccessibilityFocus).toHaveBeenCalledTimes(1));
    // Share stays where it was.
    expect(screen.getByRole("button", { name: SHARE })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: BACK_BUTTON }));

    expect(withSpring).toHaveBeenLastCalledWith(0, expect.any(Object));
    expect(screen.queryByRole("button", { name: BACK_BUTTON })).toBeNull();
    expect(screen.getByRole("button", { name: CARD_BUTTON })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Settings" })).toBeOnTheScreen();
    expect(screen.getByTestId("account-scroll").props.scrollEnabled).toBe(true);
    await waitFor(() => expect(moveAccessibilityFocus).toHaveBeenCalledTimes(2));
    expect(announce).toHaveBeenCalledTimes(1);
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
    );
    const buttons = alert.mock.calls[0][2] as AlertButton[];
    expect(buttons.map(({ text, style }) => [text, style])).toEqual([
      ["Cancel", "cancel"],
      ["Log out", "destructive"],
    ]);
    expect(buttons[0].onPress).toBeUndefined();

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
    expect(shareAsync).toHaveBeenCalledWith(MOCK_CAPTURE_URI, {
      mimeType: "image/png",
      UTI: "public.png",
      dialogTitle: "Share your ID card",
    });
    sheet.resolve();
    await waitFor(() => expect(busyOf(SHARE)).toMatchObject({ busy: false }));
    expect(toastStore.getState().current).toBeNull();
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
