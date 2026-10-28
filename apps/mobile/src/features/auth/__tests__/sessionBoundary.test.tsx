import "@/i18n";

import { useNavigationContainerRef } from "expo-router";
import { act, fireEvent, renderRouter, screen } from "expo-router/testing-library";
import { createElement, Profiler, useLayoutEffect } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { logout } from "@/api";
import {
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  seedRefreshToken,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { getAccessToken, refreshSession, sessionStore } from "../../../api/session";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { AccountScreen } from "../../account/AccountScreen";
import { CodeEntryScreen } from "../../phone/CodeEntryScreen";
import { PhoneEntryScreen } from "../../phone/PhoneEntryScreen";
import { phoneFlowStore } from "../../phone/phoneFlow";
import { HomePlaceholderScreen } from "../HomePlaceholderScreen";
import { SessionGate } from "../SessionGate";
import { METRICS, SIGNED_OUT } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

// The real (app) screens under the real gate and session: what the committed tree holds in every
// commit from the one where the session is signed out (PR #205, Vault round 1). The screens'
// test ids, the values typed into them and the ids of their controls must all be gone from the
// first signed-out commit on, not only once the switch to (auth) has landed.
const PRIVATE_IDS = [
  "home-screen",
  "home-welcome",
  "home-log-out",
  "account-screen",
  "account-identity",
  "account-log-out",
  "phone-entry-screen",
  "phone-number",
  "phone-send",
  "code-entry-screen",
  "code-sent-to",
  "phone-code",
  "phone-verify",
];
const TYPED_PHONE = "4155550123";
const TYPED_CODE = "12345";
const PRIVATE_VALUES = [user.email, "555-0123", TYPED_PHONE, TYPED_CODE];

type Commit = {
  /** Private test ids still in the committed tree (hidden elements included). */
  ids: string[];
  /** Private values (an email, a typed number or code) still in the committed tree. */
  values: string[];
  /** Private fields and controls an accessibility query still finds. */
  accessible: string[];
  /** The (app) layout's session shell is in the tree. */
  shell: boolean;
  /** The shell is reachable by the default accessibility query: it must never be. */
  shellAccessible: boolean;
  welcome: boolean;
};

let commits: Commit[] = [];
let capture = false;
let navigation: ReturnType<typeof useNavigationContainerRef>;
let fetchMock: FetchMock;

function inspect(): Commit {
  const tree = JSON.stringify(screen.toJSON());
  const byId = (id: string) => (screen.queryByTestId(id) ? [id] : []);
  return {
    ids: PRIVATE_IDS.filter((id) => tree.includes(`"${id}"`)),
    values: PRIVATE_VALUES.filter((value) => tree.includes(value)),
    accessible: [
      ...byId("phone-number"),
      ...byId("phone-code"),
      ...byId("home-log-out"),
      ...byId("account-log-out"),
      ...(screen.queryByLabelText("Verification code") ? ["code label"] : []),
      ...screen.queryAllByRole("button").map((button) => `button ${button.props.testID}`),
    ],
    shell: screen.queryByTestId("session-shell", { includeHiddenElements: true }) !== null,
    shellAccessible: screen.queryByTestId("session-shell") !== null,
    welcome: tree.includes('"public-welcome"'),
  };
}

function Root() {
  const container = useNavigationContainerRef();
  useLayoutEffect(() => {
    navigation = container; // for the tests to spy on, as of the router's first commit
  }, [container]);
  return createElement(
    SafeAreaProvider,
    { initialMetrics: METRICS },
    createElement(
      Profiler,
      {
        id: "boundary",
        onRender: () => {
          if (capture && sessionStore.getState().status === "signedOut") commits.push(inspect());
        },
      },
      createElement(SessionGate),
    ),
  );
}

const routes = {
  _layout: Root,
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Text testID="public-welcome">Welcome</Text>,
  "(auth)/login": () => <Text testID="public-login">Login</Text>,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/index": HomePlaceholderScreen,
  "(app)/account": AccountScreen,
  "(app)/verify-phone/index": PhoneEntryScreen,
  "(app)/verify-phone/code": CodeEntryScreen,
};

const signIn = (expiresIn = 900_000) =>
  sessionStore.setState({
    ...SIGNED_OUT,
    status: "signedIn",
    user,
    accessToken: "access-boundary",
    accessTokenExpiresAt: Date.now() + expiresIn,
  });

/** Replaces by the gate since the spy was set: one per switch, so Welcome is built once. */
const replaces = (spy: jest.SpyInstance) =>
  spy.mock.calls.filter(([action]) => (action as { type: string }).type === "REPLACE").length;

function expectNothingPrivate(spy: jest.SpyInstance) {
  expect(commits.length).toBeGreaterThan(0);
  const leaks = commits.map(({ ids, values, accessible }, commit) => ({
    commit,
    ids,
    values,
    accessible,
  }));
  expect(
    leaks.filter(({ ids, values, accessible }) => ids.length + values.length + accessible.length),
  ).toEqual([]);
  // The anti-flash behavior (#177): no commit holds neither a screen nor the shell, the shell is
  // never exposed to accessibility, and Welcome is on screen once the switch lands.
  expect(commits.filter((commit) => !commit.shell && !commit.welcome)).toEqual([]);
  expect(commits.filter((commit) => commit.shellAccessible)).toEqual([]);
  expect(commits.at(-1)).toMatchObject({ shell: false, welcome: true });
  expect(replaces(spy)).toBe(1);
  expect(screen.getByTestId("public-welcome")).toBeTruthy();
  expect(JSON.stringify(navigation.getRootState())).not.toContain('"name":"(app)"');
}

beforeEach(() => {
  commits = [];
  capture = false;
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  resetSecureStore();
  sessionStore.setState(SIGNED_OUT);
  phoneFlowStore.setState({ pendingNumber: null, offeredAfterSignUp: false });
  fetchMock = installFetchMock();
  fetchMock.mockResolvedValue(jsonResponse(204));
});

afterEach(() => {
  capture = false;
  jest.restoreAllMocks();
});

describe("the first signed-out commit holds nothing private (#205, Vault round 1)", () => {
  it("a log-out from the account screen removes the email and the controls at once", async () => {
    signIn();
    const view = await renderRouter(routes, { initialUrl: "/account" });
    expect(screen.getByText(user.email)).toBeTruthy();
    const spy = jest.spyOn(navigation, "dispatchSync");
    capture = true;

    await act(async () => fireEvent.press(screen.getByTestId("account-log-out")));

    expect(view.getPathname()).toBe("/welcome");
    expectNothingPrivate(spy);
  });

  it("a log-out from home removes the email and the controls at once", async () => {
    signIn();
    const view = await renderRouter(routes, { initialUrl: "/" });
    expect(screen.getByTestId("home-welcome")).toBeTruthy();
    const spy = jest.spyOn(navigation, "dispatchSync");
    capture = true;

    await act(async () => fireEvent.press(screen.getByTestId("home-log-out")));

    expect(view.getPathname()).toBe("/welcome");
    expectNothingPrivate(spy);
  });

  it("a log-out from the phone step removes the typed number at once", async () => {
    signIn();
    const view = await renderRouter(routes, { initialUrl: "/verify-phone" });
    await fireEvent.changeText(screen.getByTestId("phone-number"), TYPED_PHONE);
    expect(screen.getByDisplayValue(/555-0123/)).toBeTruthy();
    const spy = jest.spyOn(navigation, "dispatchSync");
    capture = true;

    await act(async () => logout());

    expect(view.getPathname()).toBe("/welcome");
    expectNothingPrivate(spy);
  });

  it("a refresh the server rejects removes the code step and the typed code at once", async () => {
    signIn();
    seedRefreshToken("refresh-boundary");
    phoneFlowStore.setState({ pendingNumber: TYPED_PHONE });
    const view = await renderRouter(routes, { initialUrl: "/verify-phone/code" });
    await fireEvent.changeText(screen.getByTestId("phone-code"), TYPED_CODE);
    expect(screen.getByDisplayValue(TYPED_CODE)).toBeTruthy();
    fetchMock.mockResolvedValue(errorResponse(401, "invalid_token"));
    const spy = jest.spyOn(navigation, "dispatchSync");
    capture = true;

    await act(async () => {
      await refreshSession().catch(() => undefined);
    });

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(view.getPathname()).toBe("/welcome");
    expect(phoneFlowStore.getState().pendingNumber).toBeNull();
    expectNothingPrivate(spy);
  });

  it("an expired session that cannot refresh removes the code step and the typed code at once", async () => {
    signIn(-1); // the access token has already expired: the next request refreshes first
    seedRefreshToken("refresh-boundary");
    phoneFlowStore.setState({ pendingNumber: TYPED_PHONE });
    const view = await renderRouter(routes, { initialUrl: "/verify-phone/code" });
    await fireEvent.changeText(screen.getByTestId("phone-code"), TYPED_CODE);
    fetchMock.mockResolvedValue(errorResponse(401, "invalid_token"));
    const spy = jest.spyOn(navigation, "dispatchSync");
    capture = true;

    await act(async () => {
      await getAccessToken().catch(() => undefined);
    });

    expect(sessionStore.getState().status).toBe("signedOut");
    expect(view.getPathname()).toBe("/welcome");
    expectNothingPrivate(spy);
  });
});
