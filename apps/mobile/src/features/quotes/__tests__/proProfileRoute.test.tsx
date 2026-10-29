import "@/i18n";

import { act, renderRouter, screen } from "expo-router/testing-library";
import { router, useLocalSearchParams, type Href } from "expo-router";
import { createElement, useEffect } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { user } from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import RequestLayout, {
  unstable_settings as requestSettings,
} from "../../../app/(app)/requests/[id]/_layout";
import AuthLayout, { unstable_settings } from "../../../app/(auth)/_layout";
import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { SessionGate } from "../../auth/SessionGate";
import { TabsLayout } from "../../tabs/TabsLayout";
import { redirectSystemPath, useProfileFromLink } from "../links";
import { isUuid } from "../navigation";
import { QUOTES, REQUEST_ID } from "./helpers";

// A session that changes under the mounted router, as a restore that ends signed in does.
const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
type MockSession = ReturnType<typeof import("@/api").useSession>;
const mockSession = {
  state: SESSION_SIGNED_OUT as MockSession,
  listeners: new Set<() => void>(),
  set(next: MockSession) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  },
};

jest.mock("@/api", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  return {
    useSession: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          mockSession.listeners.add(listener);
          return () => mockSession.listeners.delete(listener);
        },
        () => mockSession.state,
      ),
    logout: jest.fn(async () => undefined),
    restoreSession: jest.fn(async () => undefined),
  };
});
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

// The URLs the running app receives, as `expo-linking` hands them to Expo Router's subscription.
type UrlListener = (event: { url: string }) => void;
const urlListeners = new Set<UrlListener>();
Object.assign(jest.requireMock<object>("expo-linking"), {
  addEventListener: (_type: "url", listener: UrlListener) => {
    urlListeners.add(listener);
    return { remove: () => urlListeners.delete(listener) };
  },
});

const QUOTE_ID = QUOTES[1].id;
const LINK = `/requests/${REQUEST_ID}/quotes/${QUOTE_ID}/pro`;
const COMPARE = `/requests/${REQUEST_ID}`;

/** Every profile the router showed, with its params as the route got them. */
const profilesShown: { id: unknown; quoteId: unknown }[] = [];

function ProfileStub() {
  const { id, quoteId } = useLocalSearchParams<{ id: string; quoteId: string }>();
  useEffect(() => {
    profilesShown.push({ id, quoteId });
  }, [id, quoteId]);
  return <Text>{`profile stub ${id} ${quoteId}`}</Text>;
}

/** The comparison's frame: the real link handling around a stub body. */
function CompareStub() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useProfileFromLink(id);
  return <Text>{`compare stub ${id}`}</Text>;
}

// The real gate, groups and request stack around stub screens: what the link resolves to.
const routes = {
  _layout: () =>
    createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(SessionGate)),
  "(auth)/_layout": { default: AuthLayout, unstable_settings },
  "(auth)/welcome": () => <Text>welcome stub</Text>,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/(tabs)/_layout": TabsLayout,
  "(app)/(tabs)/index": () => <Text>home stub</Text>,
  "(app)/requests/[id]/_layout": { default: RequestLayout, unstable_settings: requestSettings },
  "(app)/requests/[id]/index": CompareStub,
  "(app)/requests/[id]/quotes/[quoteId]/pro": ProfileStub,
};

const SIGNED_IN: MockSession = { ...SESSION_SIGNED_OUT, status: "signedIn", user };
const profileShown = () => screen.getByText(`profile stub ${REQUEST_ID} ${QUOTE_ID}`);

beforeEach(() => {
  mockSession.state = SESSION_SIGNED_OUT;
  profilesShown.length = 0;
});

describe("the pro profile link", () => {
  it("resolves on a cold start once the session is restored, with the comparison under it", async () => {
    mockSession.state = { ...SESSION_SIGNED_OUT, status: "restoring" };
    const result = await renderRouter(routes, { initialUrl: LINK });
    expect(screen.queryByText(/profile stub/)).toBeNull(); // the gate holds the launch frame

    await act(async () => mockSession.set(SIGNED_IN));
    expect(result.getPathname()).toBe(LINK);
    expect(profileShown()).toBeTruthy();

    // The request stack's anchor: the comparison is under the profile the link opened.
    await act(async () => router.back());
    expect(result.getPathname()).toBe(COMPARE);
    expect(screen.getByText(`compare stub ${REQUEST_ID}`)).toBeTruthy();
  });

  it("resolves on a warm start, signed in, with the comparison under it", async () => {
    mockSession.state = SIGNED_IN;
    const result = await renderRouter(routes, { initialUrl: LINK });

    expect(result.getPathname()).toBe(LINK);
    expect(profileShown()).toBeTruthy();
    await act(async () => router.back());
    expect(result.getPathname()).toBe(COMPARE);
  });

  it("a link reaching the running app lands on the comparison, which opens the profile", async () => {
    mockSession.state = SIGNED_IN;
    const result = await renderRouter(routes, { initialUrl: "/" });
    expect(screen.getByText("home stub")).toBeTruthy();

    // What `+native-intent` makes of the link, then what the comparison does with it.
    const landing = redirectSystemPath({ path: LINK, initial: false });
    expect(landing).toBe(`${COMPARE}?profile=${QUOTE_ID}`);
    await act(async () => router.push(landing as Href)); // what the running app gets as a string
    expect(result.getPathname()).toBe(LINK);
    expect(profileShown()).toBeTruthy();

    await act(async () => router.back());
    expect(result.getPathname()).toBe(COMPARE);
    expect(screen.getByText(`compare stub ${REQUEST_ID}`)).toBeTruthy();
    await act(async () => router.back());
    expect(result.getPathname()).toBe("/");
    expect(screen.getByText("home stub")).toBeTruthy();
  });

  it("lands on welcome while signed out", async () => {
    const result = await renderRouter(routes, { initialUrl: LINK });

    expect(result.getPathname()).toBe("/welcome");
    expect(screen.queryByText(/profile stub/)).toBeNull();
  });
});

describe("a link that reaches the running app", () => {
  const OTHER_REQUEST = "6f1c2a40-0000-4000-8000-000000000999";
  const OTHER_QUOTE = QUOTES[2].id;
  const landings: string[] = [];
  // Expo Router's own chain: the native URL, `+native-intent`, the path and search params it
  // parses, the comparison's push and the href that push resolves to.
  const withIntent = {
    ...routes,
    "+native-intent": {
      redirectSystemPath: (args: { path: string; initial: boolean }) => {
        const landing = redirectSystemPath(args);
        if (!args.initial) landings.push(landing);
        return landing;
      },
    },
  };

  async function openUrl(url: string) {
    mockSession.state = SIGNED_IN;
    landings.length = 0;
    const result = await renderRouter(withIntent, { initialUrl: "/" });
    expect(screen.getByText("home stub")).toBeTruthy();
    expect(urlListeners.size).toBe(1);
    await act(async () => urlListeners.forEach((listener) => listener({ url })));
    return result;
  }

  it("opens the profile over its comparison, once", async () => {
    const result = await openUrl(`jackfixit:/${LINK}`);

    expect(landings).toEqual([`jackfixit:/${COMPARE}?profile=${QUOTE_ID}`]);
    expect(result.getPathname()).toBe(LINK);
    expect(profileShown()).toBeTruthy();
    expect(profilesShown).toEqual([{ id: REQUEST_ID, quoteId: QUOTE_ID }]);
    await act(async () => router.back());
    expect(result.getPathname()).toBe(COMPARE);
    expect(result.getSearchParams().profile).toBeUndefined();
  });

  it.each<[string, string, boolean]>([
    ["a raw & in the quote id", `${COMPARE}/quotes/${QUOTE_ID}&profile=${OTHER_QUOTE}/pro`, false],
    ["an encoded delimiter", `${COMPARE}/quotes/${QUOTE_ID}%26profile%3D../pro`, false],
    ["a double encoding", `${COMPARE}/quotes/${QUOTE_ID}%2526profile%253D../pro`, false],
    ["an encoded dot segment", `${COMPARE}/quotes/%2E%2E/pro`, false],
    ["an extra segment", `${COMPARE}/quotes/${QUOTE_ID}/pro/${OTHER_QUOTE}`, false],
    [
      "a comparison with profile segments",
      `${COMPARE}?profile=..&profile=..&profile=${OTHER_REQUEST}&profile=quotes&profile=${OTHER_QUOTE}`,
      true,
    ],
    [
      "a comparison with a repeated profile",
      `${COMPARE}?profile=${QUOTE_ID}&profile=${QUOTE_ID}`,
      true,
    ],
    ["a comparison with an encoded path", `${COMPARE}?profile=..%2F..%2F${OTHER_REQUEST}`, true],
    ["a comparison with an empty profile", `${COMPARE}?profile=`, true],
  ])("%s opens no profile it could fetch", async (_, path, landsOnCompare) => {
    const url = `jackfixit:/${path}`;
    const result = await openUrl(url);

    // Not a profile link: it lands exactly as it came.
    expect(landings).toEqual([url]);
    // No profile opened for a pair of real ids: what a route got was the link's own text.
    expect(profilesShown.filter(({ id, quoteId }) => isUuid(id) && isUuid(quoteId))).toEqual([]);
    // A forged comparison stays the comparison: it opened nothing and dropped the param.
    if (landsOnCompare) {
      expect(result.getPathname()).toBe(COMPARE);
      expect(screen.getByText(`compare stub ${REQUEST_ID}`)).toBeTruthy();
      expect(result.getSearchParams().profile).toBeUndefined();
    }
  });
});
