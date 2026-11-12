import { act, render } from "@testing-library/react-native";
import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";

import { login, logout, restoreSession, setSessionUser, useSession } from "@/api";
import i18n, { activeLanguage, setLanguage } from "@/i18n";

import {
  authResponse,
  callPath,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  seedRefreshToken,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { refreshSession, sessionStore } from "../../../api/session";
import { SIGNED_OUT } from "../../auth/__tests__/helpers";
import { AccountLanguage } from "../AccountLanguage";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
// The phone's own language, as the system reports it. Read from a global so that a fresh copy of
// the i18n module (loaded in isolation, with its own copy of this mock) sees it too.
type Device = { testDeviceLanguage?: string };
jest.mock("expo-localization", () => ({
  getLocales: () => [{ languageCode: (globalThis as Device).testDeviceLanguage ?? "en" }],
}));

const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CREDENTIALS = { email: user.email, password: "correct horse battery" };

let fetchMock: FetchMock;

function deviceIn(languageCode: string): void {
  (globalThis as Device).testDeviceLanguage = languageCode;
}

/** The server signs in (login or refresh) the account with that saved language. */
function serveAccount(locale: string, id: string = user.id): void {
  fetchMock.mockImplementation(async (...call) =>
    callPath(call) === "/v1/auth/logout"
      ? jsonResponse(204)
      : jsonResponse(200, { ...authResponse(1), user: { ...user, id, locale } }),
  );
}

beforeEach(async () => {
  fetchMock = installFetchMock();
  resetSecureStore();
  deviceIn("en");
  sessionStore.setState({ ...SIGNED_OUT, status: "restoring" });
  await i18n.changeLanguage("en");
});

/** The app's root, as far as the language goes; `work` is what the session then does. */
async function withApp(work: () => Promise<unknown>): Promise<void> {
  await render(<AccountLanguage />);
  await act(async () => {
    await work();
  });
}

describe("the app's language follows the account", () => {
  it("a restore at launch brings the account's saved language, over the device's", async () => {
    seedRefreshToken("refresh-0");
    serveAccount("es");

    await withApp(restoreSession);

    expect(sessionStore.getState().status).toBe("signedIn");
    expect(activeLanguage()).toBe("es");
  });

  it.each([
    ["en", "es"],
    ["es", "en"],
  ])("on a device in %s, a sign-in brings the account's %s", async (device, saved) => {
    deviceIn(device);
    serveAccount(saved);

    await withApp(() => login(CREDENTIALS));

    expect(activeLanguage()).toBe(saved);
  });

  it("signed out, the app goes back to the device's language", async () => {
    deviceIn("es");
    serveAccount("en");
    await withApp(() => login(CREDENTIALS));
    expect(activeLanguage()).toBe("en");

    await act(async () => {
      await logout();
    });

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(activeLanguage()).toBe("es");
  });

  it("a launch with nobody signed in stays in the device's language", async () => {
    await i18n.changeLanguage("es"); // what a device in Spanish starts in

    await withApp(restoreSession);

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(activeLanguage()).toBe("es");
  });

  it("another account brings its own", async () => {
    serveAccount("es");
    await withApp(() => login(CREDENTIALS));
    expect(activeLanguage()).toBe("es");

    serveAccount("en", OTHER_ID);
    await act(async () => {
      await login(CREDENTIALS);
    });

    expect(sessionStore.getState().user?.id).toBe(OTHER_ID);
    expect(activeLanguage()).toBe("en");
  });

  it("a fresher copy of the same account leaves the language chosen on this device", async () => {
    serveAccount("en");
    await withApp(() => login(CREDENTIALS));

    await act(async () => {
      setLanguage("es"); // chosen in Settings; the save has not reached the server
      setSessionUser({ ...user, first_name: "Maria", locale: "en" });
      await refreshSession();
    });

    expect(sessionStore.getState().user?.locale).toBe("en");
    expect(activeLanguage()).toBe("es");
  });

  it("a saved language the app is not written in leaves the device's", async () => {
    deviceIn("es");
    serveAccount("pt");

    await withApp(() => login(CREDENTIALS));

    expect(activeLanguage()).toBe("es");
  });

  it("the app's first render after a sign-in is already in the account's language", async () => {
    const renders: string[] = [];
    function Home() {
      const { t } = useTranslation();
      renders.push(t("settings.title"));
      return <Text>{t("settings.title")}</Text>;
    }
    // As the session gate: the app's screens mount one layout effect after the session signs in.
    function Gate() {
      const { status } = useSession();
      const [shown, setShown] = useState(false);
      useLayoutEffect(() => setShown(status === "signedIn"), [status]);
      return shown ? <Home /> : null;
    }
    serveAccount("es");
    await render(
      <>
        <AccountLanguage />
        <Gate />
      </>,
    );

    await act(async () => {
      await login(CREDENTIALS);
    });

    expect(renders.length).toBeGreaterThan(0);
    expect(new Set(renders)).toEqual(new Set(["Configuración"]));
  });
});

describe("the language the app starts in", () => {
  // A fresh copy of the i18n module, loaded on a device in that language.
  function startedOn(languageCode: string): string | undefined {
    deviceIn(languageCode);
    let started: string | undefined;
    jest.isolateModules(() => {
      started = jest.requireActual<typeof import("@/i18n")>("@/i18n").default.language;
    });
    return started;
  }

  it("is the device's when the app is written in it, English otherwise", () => {
    expect(startedOn("es")).toBe("es");
    expect(startedOn("en")).toBe("en");
    expect(startedOn("fr")).toBe("en");
  });
});
