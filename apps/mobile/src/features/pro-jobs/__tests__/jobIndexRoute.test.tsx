import "@/i18n";

import { act, renderRouter, screen } from "expo-router/testing-library";
import { router, useLocalSearchParams } from "expo-router";
import { createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { user } from "../../../api/__tests__/helpers";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings as authSettings } from "../../../app/(auth)/_layout";
import JobLayout, { unstable_settings as jobSettings } from "../../../app/(app)/jobs/[id]/_layout";
import JobIndex from "../../../app/(app)/jobs/[id]/index";
import { METRICS, SIGNED_OUT, WithQuery } from "../../auth/__tests__/helpers";
import { SessionGate } from "../../auth/SessionGate";

type MockSession = ReturnType<typeof import("@/api").useSession>;
const mockSession = { state: SIGNED_OUT as MockSession };

jest.mock("@/api", () => ({
  onSignOut: jest.fn(() => () => undefined),
  useSession: () => mockSession.state,
  useSessionGeneration: () => 1,
  logout: jest.fn(async () => undefined),
  restoreSession: jest.fn(async () => undefined),
}));
// The pro's real screen is ProJobScreen's own tests; here only whether it is drawn matters.
jest.mock("../ProJobScreen", () => {
  const { Text: MockText } = jest.requireActual<typeof import("react-native")>("react-native");
  return { ProJobScreen: () => <MockText>pro job screen</MockText> };
});
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

const JOB_ID = "0b9e5f8e-6a3c-4c1e-9d2f-1a2b3c4d5e6f";
const REQUEST_ID = "7f3c2b1a-0e9d-4c8b-a7f6-5e4d3c2b1a09";

function stub(name: string) {
  return function Stub() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <Text>{`${name} ${id}`}</Text>;
  };
}

// The real gate, groups, job stack and its index route; stubs for the screens over it. `chat`
// stands for a screen of the job both sides open (#74): the customer's link names its request.
const routes = {
  _layout: () =>
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(WithQuery, null, createElement(SessionGate)),
    ),
  "(auth)/_layout": { default: AuthLayout, unstable_settings: authSettings },
  "(auth)/welcome": () => <Text>welcome</Text>,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/(tabs)/index": () => <Text>home</Text>,
  "(app)/requests/[id]/job": stub("customer job"),
  "(app)/jobs/[id]/_layout": { default: JobLayout, unstable_settings: jobSettings },
  "(app)/jobs/[id]/index": JobIndex,
  "(app)/jobs/[id]/check-in": stub("check-in"),
  "(app)/jobs/[id]/chat": stub("chat"),
};

const CUSTOMER: MockSession = { ...SIGNED_OUT, status: "signedIn", user };
const PRO: MockSession = { ...SIGNED_OUT, status: "signedIn", user: { ...user, role: "pro" } };

beforeEach(() => {
  mockSession.state = SIGNED_OUT;
});

describe("a link that launches the app on one of a job's screens (cold)", () => {
  it("builds the pro's job screen under it for a pro", async () => {
    mockSession.state = PRO;
    const result = await renderRouter(routes, { initialUrl: `/jobs/${JOB_ID}/check-in` });
    expect(screen.getByText(`check-in ${JOB_ID}`)).toBeTruthy();

    await act(async () => router.back());
    expect(result.getPathname()).toBe(`/jobs/${JOB_ID}`);
    expect(screen.getByText("pro job screen")).toBeTruthy();
  });

  it("never draws the pro's screen under a customer's: Back lands on their own job", async () => {
    mockSession.state = CUSTOMER;
    const result = await renderRouter(routes, {
      initialUrl: `/jobs/${JOB_ID}/chat?request=${REQUEST_ID}`,
    });
    expect(screen.getByText(`chat ${JOB_ID}`)).toBeTruthy();
    expect(screen.queryByText("pro job screen")).toBeNull();

    await act(async () => router.back());
    expect(result.getPathname()).toBe(`/requests/${REQUEST_ID}/job`);
    expect(screen.getByText(`customer job ${REQUEST_ID}`)).toBeTruthy();
    expect(screen.queryByText("pro job screen")).toBeNull();
  });

  it("sends a customer Home when the link names no request of theirs", async () => {
    mockSession.state = CUSTOMER;
    const result = await renderRouter(routes, {
      initialUrl: `/jobs/${JOB_ID}/chat?request=not-a-uuid`,
    });
    expect(screen.queryByText("pro job screen")).toBeNull();

    await act(async () => router.back());
    expect(result.getPathname()).toBe("/");
    expect(screen.getByText("home")).toBeTruthy();
  });

  it("sends a customer Home from the pro's job link itself", async () => {
    mockSession.state = CUSTOMER;
    const result = await renderRouter(routes, { initialUrl: `/jobs/${JOB_ID}` });
    expect(result.getPathname()).toBe("/");
    expect(screen.getByText("home")).toBeTruthy();
    expect(screen.queryByText("pro job screen")).toBeNull();
  });

  it("opens the pro's job screen from that link for a pro", async () => {
    mockSession.state = PRO;
    const result = await renderRouter(routes, { initialUrl: `/jobs/${JOB_ID}` });
    expect(result.getPathname()).toBe(`/jobs/${JOB_ID}`);
    expect(screen.getByText("pro job screen")).toBeTruthy();
  });
});

describe("a link that reaches the running app (warm) keeps working", () => {
  async function openUrl(session: MockSession, url: string) {
    mockSession.state = session;
    const result = await renderRouter(routes, { initialUrl: "/" });
    expect(screen.getByText("home")).toBeTruthy();
    expect(urlListeners.size).toBe(1);
    await act(async () => urlListeners.forEach((listener) => listener({ url })));
    return result;
  }

  it("a customer's job screen link opens alone over Home", async () => {
    const result = await openUrl(CUSTOMER, `/jobs/${JOB_ID}/chat?request=${REQUEST_ID}`);
    expect(screen.getByText(`chat ${JOB_ID}`)).toBeTruthy();
    expect(screen.queryByText("pro job screen")).toBeNull();

    await act(async () => router.back());
    expect(result.getPathname()).toBe("/");
  });

  it("a pro's sheet link opens over Home", async () => {
    const result = await openUrl(PRO, `/jobs/${JOB_ID}/check-in`);
    expect(screen.getByText(`check-in ${JOB_ID}`)).toBeTruthy();
    expect(result.getPathname()).toBe(`/jobs/${JOB_ID}/check-in`);
  });

  it("a pro's job link opens the job screen", async () => {
    const result = await openUrl(PRO, `/jobs/${JOB_ID}`);
    expect(result.getPathname()).toBe(`/jobs/${JOB_ID}`);
    expect(screen.getByText("pro job screen")).toBeTruthy();
  });
});
