import "@/i18n";

import { act, screen } from "@testing-library/react-native";
import { AppState as appStateApi, Image, type AppStateStatus } from "react-native";
import { useReducedMotion as reduceMotionMock } from "react-native-reanimated";

import { ApiError, apiGet, NetworkError } from "@/api";

import { navigation, newQueryClient, renderWithQuery } from "../../../quotes/__tests__/helpers";
import type { JobPhase } from "../../phase";
import { proLocationQueryKey, jobRouteQueryKey, type JobRoute, type ProPosition } from "../api";
import { liveMapConfig } from "../config";
import { JobHero } from "../LiveMapSection";

import { distanceM, type LngLat } from "../geo";

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

const mapbox =
  jest.requireMock<typeof import("../../../../../__mocks__/@rnmapbox/maps")>("@rnmapbox/maps");

const position = (secondsAgo = 0, [lng, lat]: LngLat = at(0, 100)): ProPosition => {
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

/** The pro's last drawn feature (what the map's native source was given). */
function lastVan() {
  const calls = mapbox.mockSourceProps.mock.calls.filter(([id]) => id === "jack-van");
  const feature = JSON.parse(String(calls.at(-1)?.[1].shape)) as {
    geometry: { coordinates: [number, number] };
    properties: { bearing: number; opacity: number };
  };
  return { point: feature.geometry.coordinates as LngLat, ...feature.properties };
}

/** The app goes to the background or comes back, as React Native tells its listeners. */
const appState = {
  listeners: new Set<(state: AppStateStatus) => void>(),
  set: async (state: AppStateStatus) => {
    await act(async () => {
      appStateApi.currentState = state;
      appState.listeners.forEach((listener) => listener(state));
    });
  },
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
    .mockImplementation((frame) => clearTimeout(frame as unknown as ReturnType<typeof setTimeout>));
  navigation.reset();
  appState.listeners.clear();
  appStateApi.currentState = "active";
  jest.spyOn(appStateApi, "addEventListener").mockImplementation((_type, listener) => {
    appState.listeners.add(listener as (state: AppStateStatus) => void);
    return { remove: () => appState.listeners.delete(listener) } as ReturnType<
      typeof appStateApi.addEventListener
    >;
  });
  mapbox.mockSourceProps.mockClear();
  jest.mocked(reduceMotionMock).mockReturnValue(true);
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
    const keys = [proLocationQueryKey(JOB_ID, 1), jobRouteQueryKey(JOB_ID, 1)];
    // At once: nothing more is asked for, and the drawn map covers the live one.
    for (const queryKey of keys) {
      expect(client.getQueryCache().find({ queryKey })?.isDisabled()).toBe(true);
    }
    expect(screen.getByTestId("job-map", { includeHiddenElements: true })).toBeTruthy();
    // Once covered, the live map and its map view are gone.
    await advance(0);
    expect(screen.queryByTestId("live-map")).toBeNull();
    expect(screen.queryByTestId("live-map-view")).toBeNull();
    for (const queryKey of keys) {
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

  it("says it is waiting once the same position has been shown for a minute", async () => {
    const same = position();
    api.position = () => Promise.resolve({ position: same });
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map");
    await advance(liveMapConfig.staleMs - POLL_MS);
    expect(screen.queryByTestId("live-map-waiting")).toBeNull();
    await advance(POLL_MS);
    expect(screen.getByTestId("live-map-waiting")).toBeTruthy();
    expect(screen.getByText("Waiting for location")).toBeTruthy();
  });

  it("calls a position that arrives 90 s old waiting at once", async () => {
    api.position = () => Promise.resolve({ position: position(90) });
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map-view");
    expect(screen.getByTestId("live-map-waiting")).toBeTruthy();
    expect(lastVan().opacity).toBeLessThan(1);
  });

  it("keeps the age of a position from the cache: after a remount offline it is still old", async () => {
    const client = newQueryClient();
    client.setQueryData(proLocationQueryKey(JOB_ID, 1), position(90), { updatedAt: NOW - 90_000 });
    api.position = () => Promise.reject(new NetworkError(false));
    await renderWithQuery(hero("onTheWay"), client);
    await screen.findByTestId("live-map-view");
    expect(screen.getByTestId("live-map-waiting")).toBeTruthy();
  });

  it("times the age from the position's own time: 40 s old on arrival, waiting 20 s later", async () => {
    const same = position(40);
    api.position = () => Promise.resolve({ position: same });
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map-view");
    await advance(liveMapConfig.staleMs - 40_000 - 1000);
    expect(screen.queryByTestId("live-map-waiting")).toBeNull();
    await advance(1000);
    expect(screen.getByTestId("live-map-waiting")).toBeTruthy();
  });

  it("counts a position from ahead of the phone's clock as new: a negative age is zero", async () => {
    // The phone runs five minutes behind the server.
    const ahead = position(-300);
    api.position = () => Promise.resolve({ position: ahead });
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map-view");
    expect(screen.queryByTestId("live-map-waiting")).toBeNull();
    // It turns old a minute after its own time, on the phone's clock.
    await advance(300_000 + liveMapConfig.staleMs - POLL_MS);
    expect(screen.queryByTestId("live-map-waiting")).toBeNull();
    await advance(POLL_MS);
    expect(screen.getByTestId("live-map-waiting")).toBeTruthy();
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
  it("without a Mapbox token: a calm card, no map and no van model, and nothing is asked for", async () => {
    Object.assign(liveMapConfig, { accessToken: null });
    // The van's model is in the app: only the missing token keeps it off the screen.
    jest
      .spyOn(Image, "resolveAssetSource")
      .mockReturnValue({ uri: "assets_models_van", width: 0, height: 0, scale: 1 });
    await renderWithQuery(hero("onTheWay"));
    expect(screen.getByTestId("live-map-placeholder-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("live-map-view")).toBeNull();
    expect(screen.queryByTestId("mapbox-Models")).toBeNull();
    expect(screen.queryByTestId("mapbox-ModelLayer-jack-van-model")).toBeNull();
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

  it("when the map's style cannot load, and the map is tried again on return", async () => {
    await renderWithQuery(hero("onTheWay"));
    const map = await screen.findByTestId("live-map-view");
    await act(async () => map.props.onMapLoadingError({ error: "offline", type: "style" }));
    expect(screen.getByTestId("live-map-placeholder-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("live-map-view")).toBeNull();

    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await advance(0);
    expect(await screen.findByTestId("live-map-view")).toBeTruthy();
  });
});

describe("JobHero's live map, watched or not", () => {
  const AHEAD = at(0, 300);

  /** The pro is drawn 100 ms into a 10 s glide over 200 m. */
  async function startMoving() {
    jest.mocked(reduceMotionMock).mockReturnValue(false);
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map-view");
    await act(async () => screen.getByTestId("live-map-view").props.onDidFinishLoadingMap());
    const moved = { ...position(0, AHEAD), updated_at: new Date(NOW + POLL_MS).toISOString() };
    api.position = () => Promise.resolve({ position: moved });
    await advance(POLL_MS);
    await advance(100);
    expect(distanceM(lastVan().point, at(0, 102))).toBeLessThan(1);
    mapbox.mockSourceProps.mockClear();
    mapbox.mockCamera.setCamera.mockClear();
  }

  it("asks for nothing when it mounts out of focus, and asks once it is focused", async () => {
    navigation.setFocused(false);
    await renderWithQuery(hero("onTheWay"));
    await advance(POLL_MS * 2);
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByTestId("live-map-placeholder-loading")).toBeTruthy();

    await act(async () => navigation.setFocused(true));
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([1, 1]);
    expect(await screen.findByTestId("live-map-view")).toBeTruthy();
  });

  it("asks for nothing while the app is in the background, and asks again when it is back", async () => {
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map-view");
    await appState.set("background");
    await advance(POLL_MS * 3);
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([1, 1]);
    await appState.set("active");
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([2, 2]);
  });

  it("stops drawing the pro in the middle of a glide when the screen loses focus", async () => {
    await startMoving();
    await act(async () => navigation.setFocused(false));
    await advance(POLL_MS);
    expect(mapbox.mockSourceProps).not.toHaveBeenCalled();
    expect(mapbox.mockCamera.setCamera).not.toHaveBeenCalled();
  });

  it("stops drawing the pro in the middle of a glide when the app goes to the background", async () => {
    await startMoving();
    await appState.set("background");
    await advance(POLL_MS);
    expect(mapbox.mockSourceProps).not.toHaveBeenCalled();
    expect(mapbox.mockCamera.setCamera).not.toHaveBeenCalled();
  });

  it("back in focus, glides on from where the pro was drawn: no jump to the newest position", async () => {
    await startMoving();
    await act(async () => navigation.setFocused(false));
    await advance(POLL_MS * 3);
    await act(async () => navigation.setFocused(true));
    await advance(16);
    expect(distanceM(lastVan().point, at(0, 102))).toBeLessThan(1.5);
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(0, 201))).toBeLessThan(2);
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, AHEAD)).toBeLessThan(0.5);
  });
});

describe("JobHero's live map and a route that comes later", () => {
  it("moves a standing pro onto the route once it is back after a 503, the position unchanged", async () => {
    // 12 m beside the road, standing; the route provider is down at first.
    const same = position(0, at(12, 100));
    api.position = () => Promise.resolve({ position: same });
    api.route = () => Promise.reject(new ApiError(503, "route_unavailable"));
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map-view");
    await advance(POLL_MS);
    expect(distanceM(lastVan().point, at(12, 100))).toBeLessThan(0.1);

    api.route = () => Promise.resolve({ route: ROUTE });
    await advance(POLL_MS);
    await advance(400);
    expect(distanceM(lastVan().point, at(0, 100))).toBeLessThan(0.5);
    expect(screen.getByTestId("live-map-facts")).toBeTruthy();
  });

  it("keeps the line at the pro when the poll after a glide fails", async () => {
    jest.mocked(reduceMotionMock).mockReturnValue(false);
    await renderWithQuery(hero("onTheWay"));
    await screen.findByTestId("live-map-view");
    const moved = { ...position(0, at(0, 300)), updated_at: new Date(NOW + POLL_MS).toISOString() };
    api.position = () => Promise.resolve({ position: moved });
    await advance(POLL_MS);
    api.position = () => Promise.reject(new NetworkError(false));
    api.route = () => Promise.reject(new NetworkError(false));
    await advance(POLL_MS + 100);
    expect(distanceM(lastVan().point, at(0, 300))).toBeLessThan(0.5);
    const line = screen.getByTestId("mapbox-ShapeSource-jack-route").props.shape.geometry
      .coordinates as LngLat[];
    expect(distanceM(line[0], at(0, 300))).toBeLessThan(0.5);
  });
});

describe("JobHero's live map when the API says no", () => {
  const refuse = (status: number) => () => Promise.reject(new ApiError(status, "refused"));
  const KEYS = [proLocationQueryKey(JOB_ID, 1), jobRouteQueryKey(JOB_ID, 1)];

  it.each([
    [403, "position"],
    [404, "position"],
    [409, "position"],
    [403, "route"],
    [404, "route"],
  ] as const)(
    "on %s for the %s: the pro and the address leave the screen and the cache, the job is asked for",
    async (status, which) => {
      const client = newQueryClient();
      const refetch = jest.fn(async () => undefined);
      await renderWithQuery(hero("onTheWay", refetch), client);
      await screen.findByTestId("live-map-view");
      for (const queryKey of KEYS) expect(client.getQueryData(queryKey)).toBeDefined();

      api[which] = refuse(status);
      await advance(POLL_MS);
      expect(screen.queryByTestId("live-map")).toBeNull();
      expect(screen.queryByTestId("live-map-view")).toBeNull();
      expect(screen.getByTestId("live-map-placeholder-unavailable")).toBeTruthy();
      for (const queryKey of KEYS) expect(client.getQueryData(queryKey)).toBeUndefined();
      expect(refetch).toHaveBeenCalledTimes(1);

      // The tracking is over: no more polls, and coming back to the screen starts none.
      const asked = get.mock.calls.length;
      await advance(POLL_MS * 3);
      await act(async () => navigation.setFocused(false));
      await act(async () => navigation.setFocused(true));
      await advance(POLL_MS);
      expect(get.mock.calls.length).toBe(asked);
      for (const queryKey of KEYS) expect(client.getQueryData(queryKey)).toBeUndefined();
      expect(screen.getByTestId("live-map-placeholder-unavailable")).toBeTruthy();
    },
  );

  it("on 409 from both: the phase ended, the job is asked for again", async () => {
    const refetch = jest.fn(async () => undefined);
    await renderWithQuery(hero("onTheWay", refetch));
    await screen.findByTestId("live-map-view");
    api.position = refuse(409);
    api.route = refuse(409);
    await advance(POLL_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("live-map-view")).toBeNull();
  });

  it("refused from the first answer: no map, nothing kept, no second request", async () => {
    const client = newQueryClient();
    api.position = refuse(403);
    api.route = refuse(403);
    await renderWithQuery(hero("onTheWay"), client);
    expect(await screen.findByTestId("live-map-placeholder-unavailable")).toBeTruthy();
    await advance(POLL_MS * 2);
    expect([calls(POSITION_PATH), calls(ROUTE_PATH)]).toEqual([1, 1]);
    for (const queryKey of KEYS) expect(client.getQueryData(queryKey)).toBeUndefined();
  });

  it("drops a route that was still on its way when the position was refused", async () => {
    const client = newQueryClient();
    await renderWithQuery(hero("onTheWay"), client);
    await screen.findByTestId("live-map-view");
    let land: (answer: unknown) => void = () => undefined;
    api.position = refuse(403);
    api.route = () => new Promise((resolve) => (land = resolve));
    await advance(POLL_MS);
    expect(screen.getByTestId("live-map-placeholder-unavailable")).toBeTruthy();
    await act(async () => land({ route: ROUTE }));
    await advance(0);
    for (const queryKey of KEYS) expect(client.getQueryData(queryKey)).toBeUndefined();
    expect(screen.queryByTestId("live-map-view")).toBeNull();
  });

  it("a refusal that lands after the screen lost focus still takes the pro off it", async () => {
    const client = newQueryClient();
    const refetch = jest.fn(async () => undefined);
    await renderWithQuery(hero("onTheWay", refetch), client);
    await screen.findByTestId("live-map-view");
    let fail: (error: unknown) => void = () => undefined;
    api.position = () => new Promise((_, reject) => (fail = reject));
    await advance(POLL_MS);
    await act(async () => navigation.setFocused(false));
    await act(async () => fail(new ApiError(403, "forbidden")));
    await advance(0);
    expect(screen.queryByTestId("live-map-view")).toBeNull();
    expect(screen.getByTestId("live-map-placeholder-unavailable")).toBeTruthy();
    for (const queryKey of KEYS) expect(client.getQueryData(queryKey)).toBeUndefined();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["offline", () => new NetworkError(false)],
    ["a server error", () => new ApiError(500, "internal_error")],
  ])(
    "through %s keeps the last position, dimmed once it is old, and keeps asking",
    async (_, error) => {
      const client = newQueryClient();
      const refetch = jest.fn(async () => undefined);
      await renderWithQuery(hero("onTheWay", refetch), client);
      await screen.findByTestId("live-map-view");
      api.position = () => Promise.reject(error());
      api.route = () => Promise.reject(error());
      await advance(POLL_MS);
      expect(screen.getByTestId("live-map-view")).toBeTruthy();
      expect(screen.queryByTestId("live-map-waiting")).toBeNull();
      expect(lastVan().opacity).toBe(1);

      // Poll by poll (each failure lands before the next is due) until the position is a minute old.
      for (let due = POLL_MS; due < liveMapConfig.staleMs; due += POLL_MS) await advance(POLL_MS);
      expect(screen.getByTestId("live-map-view")).toBeTruthy();
      expect(screen.getByTestId("live-map-waiting")).toBeTruthy();
      expect(lastVan().opacity).toBeLessThan(1);
      expect(client.getQueryData(proLocationQueryKey(JOB_ID, 1))).toBeDefined();
      expect(refetch).not.toHaveBeenCalled();
      expect(calls(POSITION_PATH)).toBeGreaterThanOrEqual(7);
    },
  );
});
