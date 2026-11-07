import "@/i18n";

import { act, renderRouter, screen } from "expo-router/testing-library";
import { router, useLocalSearchParams, usePreventRemove } from "expo-router";
import { createElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { user } from "../../../api/__tests__/helpers";
import { ApiError, NetworkError } from "../../../api/errors";
import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import AuthLayout, { unstable_settings as authSettings } from "../../../app/(auth)/_layout";
import JobLayout, { unstable_settings as jobSettings } from "../../../app/(app)/jobs/[id]/_layout";
import RequestLayout, {
  unstable_settings as requestSettings,
} from "../../../app/(app)/requests/[id]/_layout";
import { METRICS, SIGNED_OUT, WithQuery } from "../../auth/__tests__/helpers";
import { SessionGate } from "../../auth/SessionGate";
import { receivePushTap } from "../pushTaps";

type MockSession = ReturnType<typeof import("@/api").useSession>;
const mockSession = {
  state: SIGNED_OUT as MockSession,
  generation: 1,
  listeners: new Set<() => void>(),
  set(next: MockSession, { newGeneration = false } = {}) {
    if (newGeneration) this.generation += 1;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  },
};

// Every API read the probes make, by path; a test sets the answer for a path.
type Answer = () => Promise<unknown>;
const mockAnswers = new Map<string, Answer>();
const mockApiGet = jest.fn((path: string) => (mockAnswers.get(path) ?? (async () => ({})))());

jest.mock("@/api", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  const errors = jest.requireActual<typeof import("../../../api/errors")>("../../../api/errors");
  return {
    ...errors,
    apiGet: (path: string) => mockApiGet(path),
    onSignOut: jest.fn(() => () => undefined),
    beforeSignOut: jest.fn(() => () => undefined),
    useSession: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          mockSession.listeners.add(listener);
          return () => mockSession.listeners.delete(listener);
        },
        () => mockSession.state,
      ),
    sessionGeneration: () => mockSession.generation,
    isCurrentGeneration: (startedIn: number) => startedIn === mockSession.generation,
    useSessionGeneration: () => mockSession.generation,
    logout: jest.fn(async () => undefined),
    restoreSession: jest.fn(async () => undefined),
  };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const ID = "0b9e5f8e-6a3c-4c1e-9d2f-1a2b3c4d5e6f";
const OTHER_ID = "7f3c2b1a-0e9d-4c8b-a7f6-5e4d3c2b1a09";

// A screen holding a draft, like the request flow and the quote form: leaving it asks first.
const mockLeaveAsked = jest.fn();
function DraftStub() {
  usePreventRemove(true, () => mockLeaveAsked());
  return <Text>draft</Text>;
}

function stub(name: string) {
  return function Stub() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <Text>{`${name} ${id}`}</Text>;
  };
}

// The real gate, groups and job/request stacks around stub screens: where a tap lands.
const routes = {
  _layout: () =>
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(WithQuery, null, createElement(SessionGate)),
    ),
  "(auth)/_layout": { default: AuthLayout, unstable_settings: authSettings },
  "(auth)/welcome": () => <Text>welcome</Text>,
  "(auth)/sign-up": () => <Text>sign-up</Text>,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/(tabs)/index": () => <Text>home</Text>,
  "(app)/requests/[id]/_layout": { default: RequestLayout, unstable_settings: requestSettings },
  "(app)/requests/[id]/index": stub("compare"),
  "(app)/requests/[id]/job": stub("customer job"),
  "(app)/jobs/[id]/_layout": { default: JobLayout, unstable_settings: jobSettings },
  "(app)/jobs/[id]/index": stub("pro job"),
  "(app)/opportunities/[id]": stub("opportunity"),
  // A real route name (typed routes); the stub stands for any screen with a draft.
  "(app)/help": DraftStub,
};

const CUSTOMER: MockSession = { ...SIGNED_OUT, status: "signedIn", user };
const PRO: MockSession = { ...SIGNED_OUT, status: "signedIn", user: { ...user, role: "pro" } };

const QUOTES_PATH = "/v1/requests/{request_id}/quotes";
const JOB_PATH = "/v1/requests/{request_id}/job";
const PRO_JOB_PATH = "/v1/pros/me/jobs/{job_id}";
const OPPORTUNITY_PATH = "/v1/pros/me/opportunities/{dispatch_id}";

const refuse =
  (status: number): Answer =>
  () =>
    Promise.reject(new ApiError(status, undefined));

/** An answer the test releases: a probe that waits on the API. */
function held(): { answer: Answer; release: () => void } {
  let release: () => void = () => undefined;
  const pending = new Promise<unknown>((resolve) => {
    release = () => resolve({});
  });
  return { answer: () => pending, release };
}

async function tap(url: unknown) {
  await act(async () => receivePushTap(url));
}

async function signedInAtHome(session: MockSession) {
  mockSession.state = session;
  const result = await renderRouter(routes, { initialUrl: "/" });
  expect(screen.getByText("home")).toBeTruthy();
  return result;
}

beforeEach(() => {
  mockSession.state = SIGNED_OUT;
  mockSession.generation = 1;
  mockAnswers.clear();
  mockApiGet.mockClear();
  mockLeaveAsked.mockClear();
});

describe("a tapped push while the app runs (warm)", () => {
  it.each([
    ["customer", CUSTOMER, `/requests/${ID}`, `compare ${ID}`, QUOTES_PATH],
    ["customer", CUSTOMER, `/requests/${ID}/job`, `customer job ${ID}`, JOB_PATH],
    ["pro", PRO, `/jobs/${ID}`, `pro job ${ID}`, PRO_JOB_PATH],
    ["pro", PRO, `/opportunities/${ID}`, `opportunity ${ID}`, OPPORTUNITY_PATH],
  ])("a %s's %s opens its screen after the API answered", async (_, session, url, text, path) => {
    const result = await signedInAtHome(session);
    await tap(url);
    expect(mockApiGet).toHaveBeenCalledWith(path);
    expect(screen.getByText(text)).toBeTruthy();
    expect(result.getPathname()).toBe(url);

    // Opened over the app: Back returns Home.
    await act(async () => router.back());
    expect(screen.getByText("home")).toBeTruthy();
  });

  it("opens a job that is still being created when the request is the customer's", async () => {
    mockAnswers.set(JOB_PATH, refuse(404));
    await signedInAtHome(CUSTOMER);
    await tap(`/requests/${ID}/job`);
    expect(mockApiGet).toHaveBeenCalledWith(QUOTES_PATH);
    expect(screen.getByText(`customer job ${ID}`)).toBeTruthy();
  });

  it("does not open the same screen twice", async () => {
    const result = await signedInAtHome(PRO);
    await tap(`/jobs/${ID}`);
    await tap(`/jobs/${ID}`);
    expect(screen.getAllByText(`pro job ${ID}`)).toHaveLength(1);
    await act(async () => router.back());
    expect(result.getPathname()).toBe("/");
  });

  it("opens a second job over the first", async () => {
    const result = await signedInAtHome(PRO);
    await tap(`/jobs/${ID}`);
    await tap(`/jobs/${OTHER_ID}`);
    expect(result.getPathname()).toBe(`/jobs/${OTHER_ID}`);
    await act(async () => router.back());
    expect(result.getPathname()).toBe(`/jobs/${ID}`);
  });

  it("still opens the screen when the API could not be reached: it shows its own error", async () => {
    mockAnswers.set(PRO_JOB_PATH, () => Promise.reject(new NetworkError(false)));
    await signedInAtHome(PRO);
    await tap(`/jobs/${ID}`);
    expect(screen.getByText(`pro job ${ID}`)).toBeTruthy();
  });
});

describe("a push that opens nothing leaves the app where it is, silently", () => {
  it.each([
    ["an unknown path", "/settings"],
    ["a path no screen opens yet", `/quotes/${ID}`],
    ["a full URL", `jackfixit://requests/${ID}`],
    ["a query", `/requests/${ID}?profile=${OTHER_ID}`],
    ["a trailing slash", `/requests/${ID}/`],
    ["an uppercase id", `/requests/${ID.toUpperCase()}`],
    ["an escaped id", `/requests/${ID.replace("-", "%2D")}`],
    ["an extra segment", `/requests/${ID}/quotes/${OTHER_ID}/pro`],
    ["no url", undefined],
    ["a url that is not a string", 42],
  ])("%s", async (_, url) => {
    const result = await signedInAtHome(CUSTOMER);
    await act(async () => router.push(`/requests/${OTHER_ID}`));
    expect(result.getPathname()).toBe(`/requests/${OTHER_ID}`);

    await tap(url);
    expect(result.getPathname()).toBe(`/requests/${OTHER_ID}`);
    expect(mockApiGet).not.toHaveBeenCalledWith(QUOTES_PATH);

    // Nothing was opened over it: Back returns Home.
    await act(async () => router.back());
    expect(screen.getByText("home")).toBeTruthy();
  });

  it.each([
    ["an unknown path", "/settings", undefined],
    ["the other role's path", `/jobs/${ID}`, undefined],
    ["another account's request", `/requests/${ID}`, 404],
  ])("never asks to discard a draft: %s", async (_, url, status) => {
    if (status !== undefined) mockAnswers.set(QUOTES_PATH, refuse(status));
    const result = await signedInAtHome(CUSTOMER);
    await act(async () => router.push("/help"));
    await tap(url);
    expect(result.getPathname()).toBe("/help");
    expect(mockLeaveAsked).not.toHaveBeenCalled();
  });

  it.each([
    ["a customer", CUSTOMER, `/jobs/${ID}`],
    ["a customer", CUSTOMER, `/opportunities/${ID}`],
    ["a pro", PRO, `/requests/${ID}`],
    ["a pro", PRO, `/requests/${ID}/job`],
  ])("%s's push for the other role: %s", async (_, session, url) => {
    const result = await signedInAtHome(session);
    await tap(url);
    expect(mockApiGet).not.toHaveBeenCalled();
    expect(result.getPathname()).toBe("/");
  });
});

describe("a push for another account never opens its screen", () => {
  it.each([
    ["a request (404)", CUSTOMER, `/requests/${ID}`, QUOTES_PATH, 404],
    ["a job's request (404 twice)", CUSTOMER, `/requests/${ID}/job`, QUOTES_PATH, 404],
    ["a pro job (404)", PRO, `/jobs/${ID}`, PRO_JOB_PATH, 404],
    ["an opportunity (404)", PRO, `/opportunities/${ID}`, OPPORTUNITY_PATH, 404],
    // The quote-accepted push names a dispatch the pro already quoted: the API answers 404 for it
    // too, so that tap opens nothing until the push names a screen that exists (follow-up).
    ["a quoted dispatch (quote accepted, 404)", PRO, `/opportunities/${ID}`, OPPORTUNITY_PATH, 404],
    ["a request (403)", CUSTOMER, `/requests/${ID}`, QUOTES_PATH, 403],
  ])("the API refuses %s: nothing opens", async (_, session, url, path, status) => {
    mockAnswers.set(path, refuse(status));
    mockAnswers.set(JOB_PATH, refuse(404));
    const result = await signedInAtHome(session);
    await tap(url);
    expect(result.getPathname()).toBe("/");
    expect(screen.queryByText(new RegExp(ID))).toBeNull();
  });

  it("tapped while signed out: a later sign-in opens nothing", async () => {
    await renderRouter(routes, { initialUrl: "/" });
    expect(screen.getByText("welcome")).toBeTruthy();
    await tap(`/requests/${ID}`);

    await act(async () => mockSession.set(CUSTOMER, { newGeneration: true }));
    expect(screen.getByText("home")).toBeTruthy();
    expect(mockApiGet).not.toHaveBeenCalledWith(QUOTES_PATH);
  });

  it("the account changed while the API was asked: nothing opens", async () => {
    const answer = held();
    mockAnswers.set(QUOTES_PATH, answer.answer);
    const result = await signedInAtHome(CUSTOMER);
    await tap(`/requests/${ID}`);

    await act(async () => mockSession.set(SIGNED_OUT, { newGeneration: true }));
    await act(async () => mockSession.set(CUSTOMER, { newGeneration: true }));
    await act(async () => answer.release());
    expect(result.getPathname()).toBe("/");
    expect(screen.queryByText(`compare ${ID}`)).toBeNull();
  });

  it("a newer tap wins over one still waiting for the API", async () => {
    const first = held();
    mockAnswers.set(PRO_JOB_PATH, first.answer);
    const result = await signedInAtHome(PRO);
    await tap(`/jobs/${ID}`);
    mockAnswers.delete(PRO_JOB_PATH);
    await tap(`/opportunities/${OTHER_ID}`);
    await act(async () => first.release());
    expect(result.getPathname()).toBe(`/opportunities/${OTHER_ID}`);
    expect(screen.queryByText(`pro job ${ID}`)).toBeNull();
  });
});

describe("a push that launched the app (cold)", () => {
  it("opens once the stored session is restored, over Home", async () => {
    mockSession.state = { ...SIGNED_OUT, status: "restoring" };
    const result = await renderRouter(routes, { initialUrl: "/" });
    await tap(`/requests/${ID}/job`);
    expect(mockApiGet).not.toHaveBeenCalled(); // nothing is asked before the session is known

    await act(async () => mockSession.set(CUSTOMER));
    expect(screen.getByText(`customer job ${ID}`)).toBeTruthy();
    expect(result.getPathname()).toBe(`/requests/${ID}/job`);
    await act(async () => router.back());
    expect(screen.getByText("home")).toBeTruthy();
  });

  it("opens a pro's job once restored", async () => {
    mockSession.state = { ...SIGNED_OUT, status: "restoring" };
    const result = await renderRouter(routes, { initialUrl: "/" });
    await tap(`/jobs/${ID}`);
    await act(async () => mockSession.set(PRO));
    expect(result.getPathname()).toBe(`/jobs/${ID}`);
    expect(screen.getByText(`pro job ${ID}`)).toBeTruthy();
  });

  it("lands on Home when the push opens nothing", async () => {
    mockSession.state = { ...SIGNED_OUT, status: "restoring" };
    const result = await renderRouter(routes, { initialUrl: "/" });
    await tap(`/quotes/${ID}`);
    await act(async () => mockSession.set(CUSTOMER));
    expect(result.getPathname()).toBe("/");
    expect(screen.getByText("home")).toBeTruthy();
  });

  it("waits through the account's sign-up flow, then opens", async () => {
    mockSession.state = { ...SIGNED_OUT, status: "restoring" };
    const result = await renderRouter(routes, { initialUrl: "/" });
    await tap(`/requests/${ID}`);
    await act(async () => mockSession.set({ ...CUSTOMER, onboardingUserId: user.id }));
    expect(screen.getByText("sign-up")).toBeTruthy();
    expect(mockApiGet).not.toHaveBeenCalled();

    // Finishing the flow keeps the session (and its generation): the push opens now.
    await act(async () => mockSession.set(CUSTOMER));
    expect(result.getPathname()).toBe(`/requests/${ID}`);
    expect(screen.getByText(`compare ${ID}`)).toBeTruthy();
  });

  it("opens nothing when the restore ends signed out, nor after the next sign-in", async () => {
    mockSession.state = { ...SIGNED_OUT, status: "restoring" };
    await renderRouter(routes, { initialUrl: "/" });
    await tap(`/requests/${ID}`);
    await act(async () => mockSession.set(SIGNED_OUT));
    expect(screen.getByText("welcome")).toBeTruthy();

    await act(async () => mockSession.set(CUSTOMER, { newGeneration: true }));
    expect(screen.getByText("home")).toBeTruthy();
    expect(mockApiGet).not.toHaveBeenCalledWith(QUOTES_PATH);
  });
});
