import "@/i18n";

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Profiler } from "react";
import { Text } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import type { JobRoute } from "../api";
import {
  FOLLOW_PITCH,
  FOLLOW_ZOOM,
  OVERVIEW_HOLD_MS,
  OVERVIEW_PITCH,
  OVERVIEW_WINDOW_MS,
  REDUCED_MOTION_MS,
} from "../camera";
import { distanceM, type LngLat } from "../geo";
import { LiveMap, ROUTE_TRIM_MS, STANDARD_STYLE_URL, type LiveMapProps } from "../LiveMap";
import type { Fix } from "../motion";

import { at, DOOR, L_ROUTE } from "./helpers";

jest.mock("@rnmapbox/maps");
jest.mock("../config", () => ({
  liveMapConfig: { accessToken: "pk.test", pollMs: 10_000, staleMs: 60_000 },
}));
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => false),
}));

const mapbox =
  jest.requireMock<typeof import("../../../../../__mocks__/@rnmapbox/maps")>("@rnmapbox/maps");

const NOW = Date.parse("2026-11-14T12:00:00Z");
const POLL_MS = 10_000;
const FRAME_MS = 16;
const HEIGHT = 320;

const fix = (point: LngLat, stamp: number, heading: number | null = null): Fix => ({
  point,
  heading,
  at: new Date(NOW + stamp).toISOString(),
});
const route = (distance: number, points: LngLat[] = L_ROUTE): JobRoute => ({
  geometry: points.map((point) => [point[0], point[1]]),
  distance_m: distance,
  duration_s: 360,
  steps: [{ street_name: "Oak Street", distance_m: 400, duration_s: 60 }],
  computed_at: new Date(NOW).toISOString(),
});

const props = (overrides: Partial<LiveMapProps> = {}): LiveMapProps => ({
  fix: fix(at(0, 100), 0, 0),
  stale: false,
  active: true,
  route: null,
  height: HEIGHT,
  cards: <Text>Cards</Text>,
  onUnavailable: jest.fn(),
  ...overrides,
});

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

/** The van's last drawn feature (what the map's native source was given). */
function lastVan() {
  const calls = mapbox.mockSourceProps.mock.calls.filter(([id]) => id === "jack-van");
  const shape = calls.at(-1)?.[1].shape;
  const feature = JSON.parse(String(shape)) as {
    geometry: { coordinates: [number, number] };
    properties: { bearing: number; opacity: number };
  };
  return { point: feature.geometry.coordinates as LngLat, ...feature.properties };
}

type Line = { geometry: { coordinates: LngLat[] } };
const routeWrites = () => mapbox.mockSourceProps.mock.calls.filter(([id]) => id === "jack-route");
/** The route's line as the frames last cut it in the map's native source. */
const lastLine = () =>
  (JSON.parse(String(routeWrites().at(-1)?.[1].shape)) as Line).geometry.coordinates;
/** The route's line as React last drew it. */
const reactLine = () =>
  (screen.getByTestId("mapbox-ShapeSource-jack-route").props.shape as Line).geometry.coordinates;

const cameraCalls = () => mapbox.mockCamera.setCamera.mock.calls.map(([stop]) => stop);
const lastCamera = () => cameraCalls().at(-1);

const loadMap = async () => {
  await act(async () => screen.getByTestId("live-map-view").props.onDidFinishLoadingMap());
};

const gesture = async (heading: number, isUserInteraction: boolean) => {
  await act(async () => {
    screen.getByTestId("mapbox-CameraGestureObserver").props.onCameraChanged({
      nativeEvent: { properties: { heading, isUserInteraction } },
    });
  });
};

beforeEach(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "clearImmediate"],
  });
  // Frames every 16 ms of fake time (the RN polyfill's 0 ms frames would never let time move).
  jest
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation(
      (callback) => setTimeout(() => callback(Date.now()), FRAME_MS) as unknown as number,
    );
  jest
    .spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation((frame) => clearTimeout(frame as unknown as ReturnType<typeof setTimeout>));
  mapbox.mockCamera.setCamera.mockClear();
  mapbox.mockSourceProps.mockClear();
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("LiveMap's Mapbox setup", () => {
  it("turns Mapbox's telemetry off right after the token, before any map is drawn", () => {
    // Both ran when the module loaded: nothing has been rendered yet.
    expect(mapbox.setAccessToken.mock.calls).toEqual([["pk.test"]]);
    expect(mapbox.setTelemetryEnabled.mock.calls).toEqual([[false]]);
    const [token] = mapbox.setAccessToken.mock.invocationCallOrder;
    const [telemetry] = mapbox.setTelemetryEnabled.mock.invocationCallOrder;
    expect(telemetry).toBe(token + 1);
  });
});

describe("LiveMap's style", () => {
  it("draws Mapbox Standard with streets, places, landmarks and 3D buildings, none hidden", async () => {
    await render(<LiveMap {...props()} />);
    const map = screen.getByTestId("live-map-view");
    expect(map.props.styleURL).toBe(STANDARD_STYLE_URL);
    expect(STANDARD_STYLE_URL).toBe("mapbox://styles/mapbox/standard");
    const { config } = screen.getByTestId("mapbox-StyleImport-basemap").props;
    expect(config).toMatchObject({
      showRoadLabels: true,
      showPlaceLabels: true,
      showPointOfInterestLabels: true,
      showTransitLabels: true,
      show3dBuildings: true,
      show3dLandmarks: true,
      show3dObjects: true,
      lightPreset: "day",
    });
    expect(Object.values(config)).not.toContain(false);
    // Mapbox's wordmark and attribution stay; the compass goes.
    expect(map.props.logoEnabled).not.toBe(false);
    expect(map.props.attributionEnabled).not.toBe(false);
    expect(map.props.compassEnabled).toBe(false);
    expect(map.props.rotateEnabled).toBe(true);
    expect(map.props.accessible).toBe(false);
  });

  it("draws the route ahead in lime under the labels, and the address's own pin at its end", async () => {
    await render(<LiveMap {...props({ route: route(1200) })} />);
    const line = screen.getByTestId("mapbox-LineLayer-jack-route-line");
    expect(line.props.slot).toBe("middle");
    expect(line.props.style.lineColor).toBe("#5EB72B");
    const coordinates = screen.getByTestId("mapbox-ShapeSource-jack-route").props.shape.geometry
      .coordinates as LngLat[];
    expect(distanceM(coordinates[0], at(0, 100))).toBeLessThan(0.5);
    expect(coordinates.at(-1)).toEqual(DOOR);
    const pin = screen.getByTestId("mapbox-SymbolLayer-jack-destination-pin");
    expect(pin.props.style.iconImage).toBe("jack-destination");
    expect(screen.getByTestId("mapbox-ShapeSource-jack-destination").props.shape.geometry).toEqual({
      type: "Point",
      coordinates: [DOOR[0], DOOR[1]],
    });
  });

  it("cuts the line back to the pro as it glides, in the native source, not through React", async () => {
    const commits = jest.fn();
    const map = (next: LiveMapProps) => (
      <Profiler id="map" onRender={commits}>
        <LiveMap {...next} />
      </Profiler>
    );
    const first = props({ route: route(1200) });
    await render(map(first));
    await screen.rerender(map({ ...first, fix: fix(at(0, 300), POLL_MS, 0) }));
    commits.mockClear();
    mapbox.mockSourceProps.mockClear();

    // Halfway through 200 m in 10 s: the line starts under the pro, at most one cut behind it.
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(0, 200))).toBeLessThan(1);
    const behind = distanceM(lastLine()[0], lastVan().point);
    expect(behind).toBeLessThan(20 * (ROUTE_TRIM_MS / 1000) + 1);
    expect(lastLine()[0][1]).toBeLessThanOrEqual(lastVan().point[1]);
    expect(lastLine().at(-1)).toEqual(DOOR);
    await advance(POLL_MS / 2 - 2 * FRAME_MS);
    // No frame went through React, and the line was cut on its own clock, not every frame.
    expect(commits).not.toHaveBeenCalled();
    expect(routeWrites().length).toBeGreaterThan(POLL_MS / ROUTE_TRIM_MS - 10);
    expect(routeWrites().length).toBeLessThanOrEqual(POLL_MS / ROUTE_TRIM_MS + 2);
  });

  it("starts the line where the pro stopped, with no newer position to come", async () => {
    const first = props({ route: route(1200) });
    await render(<LiveMap {...first} />);
    await screen.rerender(<LiveMap {...first} fix={fix(at(0, 300), POLL_MS)} />);
    await advance(POLL_MS + FRAME_MS);
    expect(distanceM(lastVan().point, at(0, 300))).toBeLessThan(0.5);
    // In the native source and in React's own copy alike.
    expect(distanceM(lastLine()[0], lastVan().point)).toBeLessThan(0.5);
    expect(distanceM(reactLine()[0], lastVan().point)).toBeLessThan(0.5);
    expect(reactLine().at(-1)).toEqual(DOOR);

    // Nothing newer comes (the next polls fail): the line stays there, and nothing is drawn again.
    mapbox.mockSourceProps.mockClear();
    await advance(POLL_MS * 3);
    expect(mapbox.mockSourceProps).not.toHaveBeenCalled();
    expect(distanceM(reactLine()[0], at(0, 300))).toBeLessThan(0.5);
  });

  it("cuts a route that changes under a gliding pro at the pro, at once", async () => {
    const first = props({ route: route(1200) });
    await render(<LiveMap {...first} />);
    const moved = { ...first, fix: fix(at(0, 300), POLL_MS, 0) };
    await screen.rerender(<LiveMap {...moved} />);
    await advance(POLL_MS / 2);
    mapbox.mockSourceProps.mockClear();
    // The same road, computed again.
    await screen.rerender(<LiveMap {...moved} route={route(1100)} />);
    expect(routeWrites()).toHaveLength(1);
    expect(distanceM(lastLine()[0], at(0, 200))).toBeLessThan(1);
  });
});

describe("LiveMap's follow camera", () => {
  it("starts on the pro, tilted and close, when there is no address to fit yet", async () => {
    await render(<LiveMap {...props()} />);
    expect(screen.getByTestId("mapbox-Camera").props.defaultSettings).toMatchObject({
      centerCoordinate: [...at(0, 100)],
      pitch: FOLLOW_PITCH,
      zoomLevel: FOLLOW_ZOOM,
      heading: 0,
    });
    expect(FOLLOW_PITCH).toBeGreaterThanOrEqual(55);
    expect(FOLLOW_PITCH).toBeLessThanOrEqual(60);
    expect(FOLLOW_ZOOM).toBeGreaterThanOrEqual(16);
    expect(FOLLOW_ZOOM).toBeLessThanOrEqual(17);
  });

  it("follows each new position along the glide, a second ahead, linearly", async () => {
    await render(<LiveMap {...props()} />);
    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 200), POLL_MS, 0) })} />);
    await advance(FRAME_MS);
    expect(lastCamera()).toMatchObject({
      pitch: FOLLOW_PITCH,
      zoomLevel: FOLLOW_ZOOM,
      animationDuration: 1000,
      animationMode: "linearTo",
    });
    // A second into a 10 s glide over 100 m, the camera heads for the van 10 m on.
    const center = lastCamera()?.centerCoordinate as LngLat;
    expect(distanceM(center, at(0, 110))).toBeLessThan(1.5);
    await advance(POLL_MS);
    expect(distanceM(lastCamera()?.centerCoordinate as LngLat, at(0, 200))).toBeLessThan(0.5);
    expect(cameraCalls().length).toBeGreaterThanOrEqual(10);
  });

  it("turns the short way: from 350 to 10 degrees it asks for 370, never back to 10", async () => {
    await render(<LiveMap {...props({ fix: fix(at(0, 100), 0, 350) })} />);
    await gesture(350, false);
    // About 10 degrees east of north, 50 m on.
    const next = at(50 * Math.sin(Math.PI / 18), 100 + 50 * Math.cos(Math.PI / 18));
    await screen.rerender(<LiveMap {...props({ fix: fix(next, POLL_MS, 10) })} />);
    await advance(FRAME_MS);
    const heading = lastCamera()?.heading as number;
    expect(heading).toBeGreaterThan(360);
    expect(heading).toBeLessThan(380);
  });

  it("stops following when the customer moves the map, and Recenter takes it back", async () => {
    await render(<LiveMap {...props()} />);
    await loadMap();
    expect(screen.queryByTestId("live-map-recenter")).toBeNull();
    await gesture(0, true);
    const recenter = screen.getByTestId("live-map-recenter");
    expect(recenter.props.accessibilityLabel).toBe("Recenter the map");
    mapbox.mockCamera.setCamera.mockClear();

    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 200), POLL_MS, 0) })} />);
    await advance(POLL_MS);
    expect(cameraCalls()).toHaveLength(0);

    await act(async () => fireEvent.press(screen.getByTestId("live-map-recenter")));
    expect(screen.queryByTestId("live-map-recenter")).toBeNull();
    expect(lastCamera()).toMatchObject({ animationMode: "easeTo", pitch: FOLLOW_PITCH });
    expect(distanceM(lastCamera()?.centerCoordinate as LngLat, at(0, 200))).toBeLessThan(0.5);
  });

  it("fits the pro and the address first, then follows once the map has loaded", async () => {
    await render(<LiveMap {...props({ route: route(1200) })} />);
    expect(cameraCalls()).toHaveLength(0);
    // The overview is placed once the map has loaded (it has no size to fit before).
    await loadMap();
    expect(cameraCalls()).toHaveLength(1);
    expect(lastCamera()).toMatchObject({ animationDuration: 0, pitch: OVERVIEW_PITCH, heading: 0 });
    expect(lastCamera()?.zoomLevel).toBeLessThan(FOLLOW_ZOOM);
    await advance(OVERVIEW_HOLD_MS);
    expect(lastCamera()).toMatchObject({ pitch: FOLLOW_PITCH, animationMode: "easeTo" });
  });

  it("gives the first overview to a route that lands just after the map loaded", async () => {
    await render(<LiveMap {...props()} />);
    await loadMap();
    await screen.rerender(<LiveMap {...props({ route: route(1200) })} />);
    expect(lastCamera()?.pitch).toBe(OVERVIEW_PITCH);
    await advance(OVERVIEW_HOLD_MS);
    expect(lastCamera()).toMatchObject({ pitch: FOLLOW_PITCH, animationMode: "easeTo" });
  });

  it("leaves the camera following when the route lands long after the map loaded", async () => {
    await render(<LiveMap {...props()} />);
    await loadMap();
    await advance(OVERVIEW_WINDOW_MS);
    mapbox.mockCamera.setCamera.mockClear();
    await screen.rerender(<LiveMap {...props({ route: route(1200) })} />);
    await advance(OVERVIEW_HOLD_MS);
    expect(cameraCalls().some((stop) => stop?.pitch === OVERVIEW_PITCH)).toBe(false);
  });

  it("keeps the van where it is drawn in the overview, not only the fix it glides to", async () => {
    const far = props({ route: route(5000) });
    await render(<LiveMap {...far} />);
    await loadMap();
    await advance(OVERVIEW_HOLD_MS);
    // A fix right by the door: on its own with the door it would zoom in to street level.
    await screen.rerender(<LiveMap {...far} fix={fix(at(380, 400), POLL_MS, 90)} />);
    await advance(FRAME_MS);
    expect(lastCamera()?.pitch).toBe(OVERVIEW_PITCH);
    expect(lastCamera()?.zoomLevel).toBeLessThan(15);
  });

  it("keeps the overview while the route of a far pro is briefly unavailable", async () => {
    const far = props({ route: route(5000) });
    await render(<LiveMap {...far} />);
    await loadMap();
    await advance(OVERVIEW_HOLD_MS);
    mapbox.mockCamera.setCamera.mockClear();
    await screen.rerender(<LiveMap {...far} route={null} fix={fix(at(0, 150), POLL_MS, 0)} />);
    await advance(POLL_MS);
    expect(cameraCalls().length).toBeGreaterThan(0);
    expect(cameraCalls().every((stop) => stop?.pitch === OVERVIEW_PITCH)).toBe(true);
  });

  it("lets Recenter's eased move finish in the middle of a glide, then steps on", async () => {
    await render(<LiveMap {...props()} />);
    await loadMap();
    await gesture(0, true);
    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 200), POLL_MS, 0) })} />);
    await advance(2000);
    await act(async () => fireEvent.press(screen.getByTestId("live-map-recenter")));
    expect(lastCamera()?.animationMode).toBe("easeTo");
    await advance(FRAME_MS * 4);
    expect(lastCamera()?.animationMode).toBe("easeTo");
    await advance(1500);
    expect(lastCamera()?.animationMode).toBe("linearTo");
  });

  it("keeps the overview while the pro is more than 3 km away, then follows", async () => {
    const far = props({ route: route(5000) });
    await render(<LiveMap {...far} />);
    await loadMap();
    await advance(OVERVIEW_HOLD_MS);
    await screen.rerender(<LiveMap {...far} fix={fix(at(0, 150), POLL_MS, 0)} />);
    await advance(FRAME_MS);
    expect(cameraCalls().every((stop) => stop?.pitch === OVERVIEW_PITCH)).toBe(true);
    expect(lastCamera()?.pitch).toBe(OVERVIEW_PITCH);

    await screen.rerender(
      <LiveMap {...far} route={route(2900)} fix={fix(at(0, 150), POLL_MS, 0)} />,
    );
    expect(lastCamera()).toMatchObject({ pitch: FOLLOW_PITCH, animationMode: "easeTo" });
  });
});

describe("LiveMap's pro", () => {
  it("glides from where it is drawn to each new position: it never jumps", async () => {
    await render(<LiveMap {...props()} />);
    expect(distanceM(lastVan().point, at(0, 100))).toBeLessThan(0.1);
    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 200), POLL_MS, 0) })} />);
    await advance(FRAME_MS);
    expect(distanceM(lastVan().point, at(0, 100))).toBeLessThan(1);
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(0, 150))).toBeLessThan(1.5);

    // A newer position halfway through starts the next glide from where the van is drawn.
    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 400), POLL_MS * 2, 0) })} />);
    await advance(FRAME_MS);
    expect(distanceM(lastVan().point, at(0, 150))).toBeLessThan(2);
    await advance(POLL_MS);
    expect(distanceM(lastVan().point, at(0, 400))).toBeLessThan(0.5);
  });

  it("is drawn on the route when its position is a little off the road", async () => {
    const first = props({ route: route(1200) });
    await render(<LiveMap {...first} />);
    await screen.rerender(<LiveMap {...first} fix={fix(at(12, 250), POLL_MS, 0)} />);
    await advance(POLL_MS + FRAME_MS);
    expect(distanceM(lastVan().point, at(0, 250))).toBeLessThan(0.5);
  });

  it("dims while its position is old", async () => {
    await render(<LiveMap {...props()} />);
    expect(lastVan().opacity).toBe(1);
    await screen.rerender(<LiveMap {...props({ stale: true })} />);
    expect(lastVan().opacity).toBeLessThan(1);
  });

  it("under Reduce Motion, neither the glide nor a camera move lasts past 300 ms", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await render(<LiveMap {...props()} />);
    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 200), POLL_MS, 90) })} />);
    await advance(REDUCED_MOTION_MS + FRAME_MS);
    expect(distanceM(lastVan().point, at(0, 200))).toBeLessThan(0.1);
    expect(lastVan().bearing).toBe(90);
    expect(cameraCalls().length).toBeGreaterThan(0);
    for (const stop of cameraCalls()) {
      expect(stop?.animationDuration).toBeLessThanOrEqual(REDUCED_MOTION_MS);
    }
  });

  it("asks for the placeholder when the map's style cannot load, not for a tile", async () => {
    const onUnavailable = jest.fn();
    await render(<LiveMap {...props({ onUnavailable })} />);
    const map = screen.getByTestId("live-map-view");
    await act(async () => map.props.onMapLoadingError({ error: "tile", type: "tile" }));
    expect(onUnavailable).not.toHaveBeenCalled();
    await act(async () => map.props.onMapLoadingError({ error: "offline", type: "style" }));
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("keeps a loaded map whatever it reports later", async () => {
    const onUnavailable = jest.fn();
    await render(<LiveMap {...props({ onUnavailable })} />);
    await loadMap();
    const map = screen.getByTestId("live-map-view");
    await act(async () => map.props.onMapLoadingError({ error: "offline", type: "style" }));
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});

describe("LiveMap's pro and a route that comes later", () => {
  it("moves a standing pro onto a first route that lands after the position, without a jump", async () => {
    // 12 m east of the road, standing: the position came first, the route after it.
    const first = props({ fix: fix(at(12, 250), 0) });
    await render(<LiveMap {...first} />);
    await loadMap();
    expect(distanceM(lastVan().point, at(12, 250))).toBeLessThan(0.1);
    await screen.rerender(<LiveMap {...first} route={route(1200)} />);
    await advance(FRAME_MS);
    expect(distanceM(lastVan().point, at(12, 250))).toBeLessThan(0.5);
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(6, 250))).toBeLessThan(0.5);
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(0, 250))).toBeLessThan(0.5);
    // It points the way the road runs there (north), not the way it hopped (west).
    expect(lastVan().bearing).toBeCloseTo(0, 0);
    expect(distanceM(reactLine()[0], at(0, 250))).toBeLessThan(0.5);
  });

  it("leaves a pro more than 25 m off the new route where it is", async () => {
    const first = props({ fix: fix(at(40, 250), 0) });
    await render(<LiveMap {...first} />);
    mapbox.mockSourceProps.mockClear();
    await screen.rerender(<LiveMap {...first} route={route(1200)} />);
    await advance(POLL_MS + FRAME_MS);
    expect(distanceM(lastVan().point, at(40, 250))).toBeLessThan(0.1);
  });

  it("keeps the arrival time of a glide when the route lands in the middle of it", async () => {
    await render(<LiveMap {...props()} />);
    const moved = props({ fix: fix(at(12, 300), POLL_MS, 0) });
    await screen.rerender(<LiveMap {...moved} />);
    await advance(POLL_MS / 2);
    const before = lastVan().point;
    expect(distanceM(before, at(6, 200))).toBeLessThan(1);
    await screen.rerender(<LiveMap {...moved} route={route(1200)} />);
    await advance(FRAME_MS);
    expect(distanceM(lastVan().point, before)).toBeLessThan(1);
    // On the road, at the fix's place on it, when the first glide was due to end.
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(0, 300))).toBeLessThan(0.5);
  });

  it("does not start a glide again for a render that brings no new position or route", async () => {
    const first = props({ route: route(1200) });
    await render(<LiveMap {...first} />);
    const moved = { ...first, fix: fix(at(0, 300), POLL_MS, 0) };
    await screen.rerender(<LiveMap {...moved} />);
    await advance(POLL_MS / 2);
    await screen.rerender(
      <LiveMap {...moved} cards={<Text>Other cards</Text>} height={HEIGHT + 40} />,
    );
    await advance(FRAME_MS);
    expect(distanceM(lastVan().point, at(0, 200))).toBeLessThan(1);
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(0, 300))).toBeLessThan(0.5);
  });
});

describe("LiveMap nobody is watching", () => {
  it("stops every frame at once, and glides on from where the pro is drawn when watched again", async () => {
    await render(<LiveMap {...props()} />);
    await loadMap();
    const moved = props({ fix: fix(at(0, 300), POLL_MS, 0) });
    await screen.rerender(<LiveMap {...moved} />);
    await advance(POLL_MS / 4);
    expect(distanceM(lastVan().point, at(0, 150))).toBeLessThan(1);

    // Blurred or in the background, in the middle of the glide; the position turns old meanwhile.
    await screen.rerender(<LiveMap {...moved} active={false} />);
    mapbox.mockSourceProps.mockClear();
    mapbox.mockCamera.setCamera.mockClear();
    await screen.rerender(<LiveMap {...moved} active={false} stale />);
    await advance(POLL_MS * 2);
    expect(mapbox.mockSourceProps).not.toHaveBeenCalled();
    expect(mapbox.mockCamera.setCamera).not.toHaveBeenCalled();

    // Back: no jump to where the old glide would have ended, a new glide from the drawn place.
    await screen.rerender(<LiveMap {...moved} stale />);
    await advance(FRAME_MS);
    expect(distanceM(lastVan().point, at(0, 150))).toBeLessThan(1);
    expect(lastVan().opacity).toBeLessThan(1);
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(0, 225))).toBeLessThan(1.5);
    await advance(POLL_MS / 2);
    expect(distanceM(lastVan().point, at(0, 300))).toBeLessThan(0.5);
    expect(cameraCalls().length).toBeGreaterThan(0);
  });

  it("mounted unwatched, places the pro once and runs no frame until it is watched", async () => {
    const idle = props({ active: false, route: route(1200) });
    await render(<LiveMap {...idle} />);
    expect(mapbox.mockSourceProps.mock.calls.filter(([id]) => id === "jack-van")).toHaveLength(1);
    expect(distanceM(lastVan().point, at(0, 100))).toBeLessThan(0.1);
    mapbox.mockSourceProps.mockClear();
    await screen.rerender(<LiveMap {...idle} fix={fix(at(0, 300), POLL_MS, 0)} />);
    await advance(POLL_MS);
    expect(mapbox.mockSourceProps).not.toHaveBeenCalled();

    await screen.rerender(<LiveMap {...idle} active fix={fix(at(0, 300), POLL_MS, 0)} />);
    await advance(FRAME_MS);
    expect(distanceM(lastVan().point, at(0, 100))).toBeLessThan(1);
    await advance(POLL_MS);
    expect(distanceM(lastVan().point, at(0, 300))).toBeLessThan(0.5);
  });
});

describe("LiveMap under Reduce Motion", () => {
  it("moves the camera for at most 300 ms in every mode: overview, its refits, follow, Recenter", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    const far = props({ route: route(5000) });
    await render(<LiveMap {...far} />);
    // The first overview is placed at once.
    await loadMap();
    expect(lastCamera()).toMatchObject({ pitch: OVERVIEW_PITCH, animationDuration: 0 });
    await advance(OVERVIEW_HOLD_MS);

    // Far away, the overview fits each new position again.
    mapbox.mockCamera.setCamera.mockClear();
    await screen.rerender(<LiveMap {...far} fix={fix(at(0, 200), POLL_MS, 0)} />);
    expect(cameraCalls().length).toBeGreaterThan(0);
    expect(lastCamera()).toMatchObject({
      pitch: OVERVIEW_PITCH,
      animationDuration: REDUCED_MOTION_MS,
    });
    await advance(REDUCED_MOTION_MS + FRAME_MS);

    // Closer than 3 km: the overview gives way to following.
    const near = { ...far, route: route(2900), fix: fix(at(0, 200), POLL_MS, 0) };
    await screen.rerender(<LiveMap {...near} />);
    expect(lastCamera()).toMatchObject({
      pitch: FOLLOW_PITCH,
      animationMode: "easeTo",
      animationDuration: REDUCED_MOTION_MS,
    });
    // Following a glide.
    await screen.rerender(<LiveMap {...near} fix={fix(at(0, 300), 2 * POLL_MS, 0)} />);
    await advance(REDUCED_MOTION_MS + FRAME_MS);
    expect(distanceM(lastCamera()?.centerCoordinate as LngLat, at(0, 300))).toBeLessThan(0.5);

    // Freed by a gesture, then Recenter.
    await gesture(0, true);
    mapbox.mockCamera.setCamera.mockClear();
    await act(async () => fireEvent.press(screen.getByTestId("live-map-recenter")));
    expect(lastCamera()).toMatchObject({
      pitch: FOLLOW_PITCH,
      animationMode: "easeTo",
      animationDuration: REDUCED_MOTION_MS,
    });
  });

  it("never asks the camera for a longer move, whatever happened", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    const setCamera = mapbox.mockCamera.setCamera;
    const far = props({ route: route(5000) });
    await render(<LiveMap {...far} />);
    await loadMap();
    await advance(OVERVIEW_HOLD_MS);
    await screen.rerender(<LiveMap {...far} fix={fix(at(0, 200), POLL_MS, 0)} />);
    await advance(POLL_MS);
    const near = { ...far, route: route(2900) };
    await screen.rerender(<LiveMap {...near} fix={fix(at(0, 300), 2 * POLL_MS, 0)} />);
    await advance(POLL_MS);
    await gesture(0, true);
    await act(async () => fireEvent.press(screen.getByTestId("live-map-recenter")));
    await screen.rerender(<LiveMap {...near} fix={fix(at(0, 380), 3 * POLL_MS, 0)} />);
    await advance(POLL_MS);
    const durations = setCamera.mock.calls.map(([stop]) => stop.animationDuration as number);
    expect(durations.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...durations)).toBeLessThanOrEqual(300);
    expect(REDUCED_MOTION_MS).toBeLessThanOrEqual(300);
  });
});

describe("LiveMap's camera nobody is watching", () => {
  it("stays put when the first overview ends or a far position lands, and is placed on the way back", async () => {
    const far = props({ route: route(5000) });
    await render(<LiveMap {...far} />);
    await loadMap();
    // Blurred during the first overview's hold.
    await advance(OVERVIEW_HOLD_MS / 2);
    await screen.rerender(<LiveMap {...far} active={false} />);
    mapbox.mockCamera.setCamera.mockClear();
    await advance(OVERVIEW_HOLD_MS);
    // A position that was on its way lands, and the pro is now close enough to follow.
    const near = { ...far, route: route(2900), fix: fix(at(0, 200), POLL_MS, 0) };
    await screen.rerender(<LiveMap {...near} active={false} />);
    await advance(POLL_MS);
    expect(mapbox.mockCamera.setCamera).not.toHaveBeenCalled();

    await screen.rerender(<LiveMap {...near} />);
    expect(lastCamera()).toMatchObject({ pitch: FOLLOW_PITCH, animationMode: "easeTo" });
  });

  it("fits the overview again when a far pro's map is watched again", async () => {
    const far = props({ route: route(5000) });
    await render(<LiveMap {...far} />);
    await loadMap();
    await advance(OVERVIEW_HOLD_MS);
    await screen.rerender(<LiveMap {...far} active={false} />);
    mapbox.mockCamera.setCamera.mockClear();
    await screen.rerender(<LiveMap {...far} active={false} fix={fix(at(0, 200), POLL_MS, 0)} />);
    expect(mapbox.mockCamera.setCamera).not.toHaveBeenCalled();
    await screen.rerender(<LiveMap {...far} fix={fix(at(0, 200), POLL_MS, 0)} />);
    expect(lastCamera()).toMatchObject({ pitch: OVERVIEW_PITCH });
  });
});

describe("LiveMap's pro, back with nothing new", () => {
  it("keeps the way a standing pro points, and draws nothing but the frame back", async () => {
    // Standing on a road that runs north, pointing east.
    const first = props({ fix: fix(at(0, 100), 0, 90), route: route(1200) });
    await render(<LiveMap {...first} />);
    expect(lastVan().bearing).toBe(90);
    await screen.rerender(<LiveMap {...first} active={false} />);
    await screen.rerender(<LiveMap {...first} />);
    await advance(POLL_MS);
    expect(lastVan().bearing).toBe(90);
    expect(distanceM(lastVan().point, at(0, 100))).toBeLessThan(0.1);
  });

  it("draws a route that lands while unwatched from where the pro stands, not from its last rest", async () => {
    const first = props({ route: route(1200) });
    await render(<LiveMap {...first} />);
    const moved = { ...first, fix: fix(at(0, 300), POLL_MS, 0) };
    await screen.rerender(<LiveMap {...moved} />);
    await advance(POLL_MS / 2);
    await screen.rerender(<LiveMap {...moved} active={false} />);
    mapbox.mockSourceProps.mockClear();
    await screen.rerender(<LiveMap {...moved} active={false} route={route(1100)} />);
    expect(mapbox.mockSourceProps).not.toHaveBeenCalled();
    expect(distanceM(reactLine()[0], at(0, 200))).toBeLessThan(1);
  });
});
