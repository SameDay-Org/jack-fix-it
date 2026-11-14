import "@/i18n";

import { act, screen } from "@testing-library/react-native";

import { ApiError, apiGet, NetworkError } from "@/api";

import { navigation, newQueryClient, renderWithQuery } from "../../../quotes/__tests__/helpers";
import type { JobPhase } from "../../phase";
import { proLocationQueryKey, jobRouteQueryKey, type JobRoute, type ProPosition } from "../api";
import { liveMapConfig } from "../config";
import { JobHero } from "../LiveMapSection";

import { at, L_ROUTE } from "./helpers";

jest.mock("@rnmapbox/maps");
jest.mock("../config", () => ({
  liveMapConfig: { accessToken: "pk.test", pollMs: 10_000, staleMs: 60_000 },
}));
jest.mock("@/api", () => ({
  ...jest.requireActual("../../../../api/errors"),
  apiGet: jest.fn(),
  useSession: () => ({ status: "signedIn", user: null }),
  useSessionGeneration: () => 1,
}));
jest.mock("expo-router", () => jest.requireActual("../../../quotes/__tests__/helpers").routerMock);
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const NOW = Date.parse("2026-11-14T12:00:00Z");
const POLL_MS = 10_000;
const JOB_ID = "6f1c2a40-0000-4000-8000-000000000353";
const POSITION_PATH = "/v1/jobs/{job_id}/pro-location";
const ROUTE_PATH = "/v1/jobs/{job_id}/route";

const position = (secondsAgo = 0): ProPosition => {
  const [lng, lat] = at(0, 100);
  return {
    lat,
    lng,
    accuracy_m: 5,
    heading_deg: 0,
    updated_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  };
};
const ROUTE: JobRoute = {
  geometry: L_ROUTE.map((point) => [point[0], point[1]]),
  distance_m: 1931,
  duration_s: 371,
  steps: [{ street_name: "Oak Street", distance_m: 400, duration_s: 60 }],
  computed_at: new Date(NOW).toISOString(),
};

type Get = (path: string, options?: unknown) => Promise<unknown>;
const get = apiGet as unknown as jest.MockedFunction<Get>;
const api = {
  position: (): Promise<unknown> => Promise.resolve({ position: position() }),
  route: (): Promise<unknown> => Promise.resolve({ route: ROUTE }),
};
const calls = (path: string) => get.mock.calls.filter(([called]) => called === path).length;

// Moves fake time on, then lets the answers that came in land (TanStack notifies on a 0 ms timer).
const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
};

function hero(phase: JobPhase, refetch = jest.fn(async () => undefined)) {
  return (
    <JobHero
      jobId={JOB_ID}
      etaAt={new Date(NOW + 12 * 60_000).toISOString()}
      phase={phase}
      travel={1}
      name="Dan"
      now={NOW}
      refetch={refetch}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "clearImmediate"],
  });
  jest
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation(
      (callback) => setTimeout(() => callback(Date.now()), 16) as unknown as number,
    );
  jest
    .spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation((frame) => clearTimeout(frame as unknown as NodeJS.Timeout));
  navigation.reset();
  Object.assign(liveMapConfig, { accessToken: "pk.test" });
  api.position = () => Promise.resolve({ position: position() });
  api.route = () => Promise.resolve({ route: ROUTE });
  get.mockReset().mockImplementation((path) => {
    if (path === POSITION_PATH) return api.position();
    if (path === ROUTE_PATH) return api.route();
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("JobHero's live map", () => {
  it("shows the pro on the live map with the time, distance and street", async () => {
    await renderWithQuery(hero("onTheWay"));
    expect(await screen.findByTestId("live-map")).toBeTruthy();
    expect(screen.getByTestId("live-map-eta").props.children).toBe("6 min");
    expect(screen.getByTestId("live-map-facts").props.children).toBe("1.2 mi · On Oak Street");
    expect(screen.getByTestId("live-map-cards").props.accessibilityLabel).toBe(
      "Dan is 6 min away, on Oak Street",
    );
    expect(screen.queryByTestId("live-map-waiting")).toBeNull();
  });

  it("asks every 10 s only while the screen is focused", async () => {
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map");
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([1, 1]);

    await advance(POLL_MS);
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([2, 2]);

    await act(async () => navigation.setFocused(false));
    await advance(POLL_MS * 3);
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([2, 2]);

    // Back in focus it asks at once, then polls again.
    await act(async () => navigation.setFocused(true));
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([3, 3]);
    await advance(POLL_MS);
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([4, 4]);
  });

  it("leaves with the phase: the map unmounts, the asking stops, the drawn map is back", async () => {
    const client = newQueryClient();
    await renderWithQuery(hero("onTheWay"), client);
    await screen.findByTestId("live-map");

    await screen.rerender(hero("arrived"));
    expect(screen.queryByTestId("live-map")).toBeNull();
    expect(screen.queryByTestId("live-map-view")).toBeNull();
    expect(screen.getByTestId("job-map", { includeHiddenElements: true })).toBeTruthy();
    for (const queryKey of [proLocationQueryKey(JOB_ID, 1), jobRouteQueryKey(JOB_ID, 1)]) {
      expect(client.getQueryCache().find({ queryKey })?.getObserversCount()).toBe(0);
    }
    const before = calls(POSITION_PATH);
    await advance(POLL_MS * 3);
    expect(calls(POSITION_PATH)).toBe(before);
  });

  it("without a route (503 or none) keeps the pro on the map and the pro's own arrival time", async () => {
    api.route = () => Promise.reject(new ApiError(503, "route_unavailable"));
    await renderWithQuery(hero("onTheWay"));
    expect(await screen.findByTestId("live-map")).toBeTruthy();
    expect(screen.getByTestId("live-map-eta").props.children).toBe("12 min");
    expect(screen.queryByTestId("live-map-facts")).toBeNull();
    expect(screen.getByTestId("live-map-cards").props.accessibilityLabel).toBe(
      "Dan is 12 min away",
    );

    api.route = () => Promise.resolve({ route: null });
    await advance(POLL_MS);
    expect(screen.getByTestId("live-map-eta").props.children).toBe("12 min");
  });

  it("says it is waiting once the position is a minute old", async () => {
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map");
    api.position = () => Promise.resolve({ position: position(POLL_MS / 1000) });
    await advance(liveMapConfig.staleMs);
    expect(screen.getByTestId("live-map-waiting")).toBeTruthy();
    expect(screen.getByText("Waiting for location")).toBeTruthy();
  });

  it("keeps the last position, dimmed, once the API stops sending one, and asks for the job again", async () => {
    const refetch = jest.fn(async () => undefined);
    await renderWithQuery(hero("onTheWay", refetch));
    await screen.findByTestId("live-map");
    api.position = () => Promise.resolve({ position: null });
    await advance(POLL_MS);
    expect(screen.getByTestId("live-map")).toBeTruthy();
    expect(screen.getByTestId("live-map-cards").props.accessibilityLabel).toBe(
      "Waiting for Dan's location",
    );
    expect(refetch).toHaveBeenCalledTimes(1);
    await advance(POLL_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("JobHero's placeholders", () => {
  it("without a Mapbox token: a calm card, and nothing is asked for", async () => {
    Object.assign(liveMapConfig, { accessToken: null });
    await renderWithQuery(hero("onTheWay"));
    expect(screen.getByTestId("live-map-placeholder-unavailable")).toBeTruthy();
    expect(screen.getByText("The live map isn't available")).toBeTruthy();
    await advance(POLL_MS * 2);
    expect(get).not.toHaveBeenCalled();
  });

  it("while the first position loads", async () => {
    api.position = () => new Promise(() => undefined);
    await renderWithQuery(hero("onTheWay"));
    expect(screen.getByTestId("live-map-placeholder-loading")).toBeTruthy();
    expect(screen.getByText("Loading the live map")).toBeTruthy();
  });

  it("before the pro shares a position", async () => {
    api.position = () => Promise.resolve({ position: null });
    await renderWithQuery(hero("onTheWay"));
    expect(await screen.findByTestId("live-map-placeholder-waiting")).toBeTruthy();
    expect(screen.getByText("Waiting for Dan's location")).toBeTruthy();
  });

  it("offline, and the map comes once a position does", async () => {
    api.position = () => Promise.reject(new NetworkError(false));
    await renderWithQuery(hero("onTheWay"));
    expect(await screen.findByTestId("live-map-placeholder-offline")).toBeTruthy();
    api.position = () => Promise.resolve({ position: position() });
    await advance(POLL_MS);
    expect(screen.getByTestId("live-map")).toBeTruthy();
  });

  it("when the map's style cannot load", async () => {
    await renderWithQuery(hero("onTheWay"));
    const map = await screen.findByTestId("live-map-view");
    await act(async () => map.props.onMapLoadingError({ error: "offline", type: "style" }));
    expect(screen.getByTestId("live-map-placeholder-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("live-map-view")).toBeNull();
  });
});
