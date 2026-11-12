import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { logout } from "@/api";
import i18n from "@/i18n";

import {
  callBody,
  callPath,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  settle,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { sessionStore } from "../../../api/session";
import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { AccountLanguage } from "../AccountLanguage";
import { SettingsScreen } from "../SettingsScreen";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
  useIsFocused: () => true,
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

type Answer = ReturnType<typeof deferred<Response>>;

let fetchMock: FetchMock;
/** One entry per `PATCH /v1/auth/me` the app sent, in order; the test answers each by hand. */
let saves: Answer[];

const saveCalls = () =>
  fetchMock.mock.calls.filter(
    (call) => callPath(call) === "/v1/auth/me" && call[1]?.method === "PATCH",
  );
const saved = (locale: string) => jsonResponse(200, { ...user, locale });
const sessionLocale = () => sessionStore.getState().user?.locale;
const radio = (name: string) => screen.getByRole("radio", { name });
const notice = () => screen.queryByTestId("settings-language-unsaved");

function signIn(locale: string): void {
  sessionStore.setState({
    ...SIGNED_OUT,
    status: "signedIn",
    user: { ...user, locale },
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
  });
}

async function renderSettings() {
  // Nothing in the cache expires: a garbage-collection timer would outlive the test.
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        {/* As the root layout mounts it: the app's language follows the account. */}
        <AccountLanguage />
        <SettingsScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

/** Settles the save the app sent `index`-th, and lets what follows from it happen. */
async function answer(index: number, settleWith: (save: Answer) => void): Promise<void> {
  await waitFor(() => expect(saves.length).toBeGreaterThan(index));
  await act(async () => {
    settleWith(saves[index]!);
    await settle();
  });
}

beforeEach(async () => {
  saves = [];
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) => {
    if (callPath(call) === "/v1/auth/logout") return jsonResponse(204);
    const save = deferred<Response>();
    saves.push(save);
    return save.promise;
  });
  resetSecureStore();
  await i18n.changeLanguage("en");
  signIn("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("Settings: language", () => {
  it("lists each language in itself, as radios, the one on screen checked", async () => {
    await renderSettings();

    expect(screen.getByText("Language")).toBeOnTheScreen();
    expect(screen.getAllByRole("radio").map((row) => row.props.accessibilityLabel)).toEqual([
      "English",
      "Español",
    ]);
    expect(radio("English")).toBeChecked();
    expect(radio("Español")).not.toBeChecked();
    expect(screen.getByTestId("settings-language").props).toMatchObject({
      accessibilityRole: "radiogroup",
      accessibilityLabel: "Language",
    });
    // Each name is pronounced in its own language.
    expect(radio("Español").props.accessibilityLanguage).toBe("es");
    expect(notice()).toBeNull();
  });

  it("checks the language on screen when the app is in Spanish", async () => {
    await i18n.changeLanguage("es");
    signIn("es");

    await renderSettings();

    expect(screen.getByText("Idioma")).toBeOnTheScreen();
    expect(radio("Español")).toBeChecked();
    expect(radio("English")).not.toBeChecked();
  });

  it("choosing Español puts the app in Spanish at once, then saves it to the account", async () => {
    await renderSettings();

    await fireEvent.press(radio("Español"));

    // Live, before the server has answered: the whole screen reads in Spanish.
    expect(i18n.language).toBe("es");
    expect(screen.getByRole("header", { name: "Configuración" })).toBeOnTheScreen();
    expect(screen.getByTestId("settings-email")).toHaveTextContent("Correomaria@example.com");
    expect(radio("Español")).toBeChecked();
    expect(radio("English")).not.toBeChecked();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(callBody(saveCalls()[0]!)).toEqual({ locale: "es" });
    expect(notice()).toBeNull();

    await answer(0, (save) => save.resolve(saved("es")));

    await waitFor(() => expect(sessionLocale()).toBe("es"));
    expect(screen.getByRole("header", { name: "Configuración" })).toBeOnTheScreen();
    expect(notice()).toBeNull();
    expect(saveCalls()).toHaveLength(1);
  });

  it.each([
    [
      "there is no connection",
      (save: Answer) => save.reject(new TypeError("Network request failed")),
    ],
    ["the server fails", (save: Answer) => save.resolve(errorResponse(503, "unavailable"))],
  ])("when %s, the device keeps the chosen language and says it is not saved", async (_, fail) => {
    await renderSettings();
    await fireEvent.press(radio("Español"));

    await answer(0, fail);
    await waitFor(() => expect(notice()).toBeOnTheScreen());

    expect(i18n.language).toBe("es");
    expect(screen.getByRole("header", { name: "Configuración" })).toBeOnTheScreen();
    expect(radio("Español")).toBeChecked();
    expect(sessionLocale()).toBe("en");
    expect(notice()).toHaveTextContent(
      "Aún no se guardó en tu cuentaEste dispositivo sigue en español. Puedes intentarlo de nuevo en un momento.Reintentar",
    );
  });

  it("sends the choice again from the notice, which stays up until it is saved", async () => {
    await renderSettings();
    await fireEvent.press(radio("Español"));
    await answer(0, (save) => save.reject(new TypeError("Network request failed")));

    await fireEvent.press(await screen.findByRole("button", { name: "Reintentar" }));

    await waitFor(() => expect(saves).toHaveLength(2));
    expect(callBody(saveCalls()[1]!)).toEqual({ locale: "es" });
    expect(notice()).toBeOnTheScreen();
    expect(screen.getByTestId("settings-language-retry")).toBeBusy();

    // Still failing: the notice is there, its button ready again, and a screen reader is told
    // (the notice's text has not changed, so it would announce nothing by itself).
    const spoken = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
    spoken.mockClear();
    await answer(1, (save) => save.reject(new TypeError("Network request failed")));
    await waitFor(() => expect(screen.getByTestId("settings-language-retry")).not.toBeBusy());
    expect(notice()).toBeOnTheScreen();
    expect(spoken.mock.calls).toEqual([["Aún no se guardó en tu cuenta", { queue: true }]]);

    await fireEvent.press(screen.getByRole("button", { name: "Reintentar" }));
    await answer(2, (save) => save.resolve(saved("es")));

    await waitFor(() => expect(notice()).toBeNull());
    expect(sessionLocale()).toBe("es");
    expect(i18n.language).toBe("es");
  });

  it("a new choice during a retry is a first save again: no notice while it is on its way", async () => {
    await renderSettings();
    await fireEvent.press(radio("Español"));
    await answer(0, (save) => save.reject(new TypeError("Network request failed")));
    await fireEvent.press(await screen.findByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(saves).toHaveLength(2));

    const spoken = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
    spoken.mockClear();
    await fireEvent.press(radio("English"));

    expect(notice()).toBeNull();
    // The retry lands: the account holds Spanish while English is still being saved.
    await answer(1, (save) => save.resolve(saved("es")));
    await waitFor(() => expect(sessionLocale()).toBe("es"));
    expect(notice()).toBeNull();
    expect(screen.getByRole("header", { name: "Settings" })).toBeOnTheScreen();
    await waitFor(() => expect(saves).toHaveLength(3));
    expect(callBody(saveCalls()[2]!)).toEqual({ locale: "en" });

    await answer(2, (save) => save.resolve(saved("en")));

    await waitFor(() => expect(sessionLocale()).toBe("en"));
    expect(notice()).toBeNull();
    expect(radio("English")).toBeChecked();
    // Not for one render either: a notice that showed and went would have been spoken.
    expect(spoken).not.toHaveBeenCalled();
  });

  it("a retry that fails after a new choice says nothing: it no longer speaks for the screen", async () => {
    await renderSettings();
    await fireEvent.press(radio("Español"));
    await answer(0, (save) => save.reject(new TypeError("Network request failed")));
    await fireEvent.press(await screen.findByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(saves).toHaveLength(2));

    const spoken = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
    spoken.mockClear();
    await fireEvent.press(radio("English"));
    expect(notice()).toBeNull();

    // The Spanish retry fails while English waits its turn, then English is saved: the account
    // and the screen agree, and nothing was left unsaved to tell a screen reader about.
    await answer(1, (save) => save.reject(new TypeError("Network request failed")));
    await waitFor(() => expect(saves).toHaveLength(3));
    await answer(2, (save) => save.resolve(saved("en")));

    await waitFor(() => expect(sessionLocale()).toBe("en"));
    expect(i18n.language).toBe("en");
    expect(notice()).toBeNull();
    expect(spoken).not.toHaveBeenCalled();
  });

  it("shows no notice for an account saved in a language the app is not written in", async () => {
    signIn("pt");

    await renderSettings();

    expect(radio("English")).toBeChecked();
    expect(notice()).toBeNull();
  });

  it("sends nothing when the language on screen is chosen again", async () => {
    await renderSettings();

    await fireEvent.press(radio("English"));
    await act(settle);

    expect(saveCalls()).toHaveLength(0);
    expect(i18n.language).toBe("en");
  });

  it("saves one choice at a time, so the account ends on the last one", async () => {
    await renderSettings();

    await fireEvent.press(radio("Español"));
    await waitFor(() => expect(saves).toHaveLength(1));
    await fireEvent.press(radio("English"));
    await act(settle);

    // The second waits for the first to settle; the screen is already back in English.
    expect(saveCalls()).toHaveLength(1);
    expect(screen.getByRole("header", { name: "Settings" })).toBeOnTheScreen();

    await answer(0, (save) => save.resolve(saved("es")));

    // The first answer changes the account's copy, never the language chosen since.
    await waitFor(() => expect(sessionLocale()).toBe("es"));
    expect(screen.getByRole("header", { name: "Settings" })).toBeOnTheScreen();
    expect(notice()).toBeNull();
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(callBody(saveCalls()[1]!)).toEqual({ locale: "en" });

    await answer(1, (save) => save.resolve(saved("en")));

    await waitFor(() => expect(sessionLocale()).toBe("en"));
    expect(radio("English")).toBeChecked();
    expect(notice()).toBeNull();
  });

  it("never sends a choice still waiting its turn for the next session", async () => {
    await renderSettings();
    await fireEvent.press(radio("Español"));
    await waitFor(() => expect(saves).toHaveLength(1));
    await fireEvent.press(radio("English"));

    await act(async () => {
      await logout();
    });
    signIn("es"); // somebody signs in before the first save has settled
    await answer(0, (save) => save.reject(new TypeError("Network request failed")));
    await act(settle);

    expect(saveCalls()).toHaveLength(1);
    expect(sessionLocale()).toBe("es");
  });
});
