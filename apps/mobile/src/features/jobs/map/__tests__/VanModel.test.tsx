import "@/i18n";

import { act, render, screen } from "@testing-library/react-native";
import { Image, Text } from "react-native";

import type { JobRoute } from "../api";
import { FOLLOW_ZOOM } from "../camera";
import { distanceM, type LngLat } from "../geo";
import { LiveMap, type LiveMapProps } from "../LiveMap";
import type { Fix } from "../motion";
import { STALE_OPACITY, vanModelSource, vanRotation, vanScale } from "../VanModel";

import { at, L_ROUTE } from "./helpers";

jest.mock("@rnmapbox/maps");
jest.mock("../config", () => ({
  liveMapConfig: { accessToken: "pk.test", pollMs: 10_000, staleMs: 60_000 },
}));

const mapbox =
  jest.requireMock<typeof import("../../../../../__mocks__/@rnmapbox/maps")>("@rnmapbox/maps");

const NOW = Date.parse("2026-11-15T12:00:00Z");
const POLL_MS = 10_000;
const FRAME_MS = 16;
// Node's own modules, typed here as far as this file uses them (the app has no Node types).
// Jest runs from apps/mobile.
const { readFileSync } = jest.requireActual<{ readFileSync: (path: string) => Uint8Array }>("fs");
const { execFileSync } = jest.requireActual<{
  execFileSync: (file: string, args: string[], options: { stdio: "pipe" }) => unknown;
}>("child_process");
const MODEL_FILE = "assets/models/van.glb";
const GENERATOR = "scripts/generate-van-model.mjs";
const MODEL_LAYER = "mapbox-ModelLayer-jack-van-model";
const ARROW_LAYER = "mapbox-SymbolLayer-jack-van-arrow";
// The asset as a build carries it, and as a development server serves it.
const BUNDLED = { uri: "assets_models_van", width: 0, height: 0, scale: 1 };
const SERVED = {
  ...BUNDLED,
  uri: "http://10.0.2.2:8081/assets/?unstable_path=.%2Fassets%2Fmodels%2Fvan.glb&platform=android&hash=4d1f",
};

const fix = (point: LngLat, stamp: number, heading: number | null = null): Fix => ({
  point,
  heading,
  at: new Date(NOW + stamp).toISOString(),
});
const route = (): JobRoute => ({
  geometry: L_ROUTE.map((point) => [point[0], point[1]]),
  distance_m: 1200,
  duration_s: 360,
  steps: [{ street_name: "Oak Street", distance_m: 400, duration_s: 60 }],
  computed_at: new Date(NOW).toISOString(),
});
const props = (overrides: Partial<LiveMapProps> = {}): LiveMapProps => ({
  fix: fix(at(0, 100), 0, 0),
  stale: false,
  active: true,
  route: null,
  height: 320,
  cards: <Text>Cards</Text>,
  onUnavailable: jest.fn(),
  ...overrides,
});

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

type VanFeature = {
  geometry: { coordinates: [number, number] };
  properties: {
    bearing: number;
    rotation: [number, number, number];
    scale: [number, number, number];
    opacity: number;
  };
};
/** Every feature the frames wrote for the pro, oldest first. */
const vanWrites = () =>
  mapbox.mockSourceProps.mock.calls
    .filter(([id]) => id === "jack-van")
    .map(([, written]) => JSON.parse(String(written.shape)) as VanFeature);
const lastVan = () => vanWrites().at(-1) as VanFeature;

/** The map reports its camera, as it does on every change of it. */
const cameraAt = async (zoom: number) => {
  await act(async () => {
    screen.getByTestId("mapbox-CameraGestureObserver").props.onCameraChanged({
      nativeEvent: { properties: { heading: 0, zoom, isUserInteraction: false } },
    });
  });
};

const withAsset = (source: typeof BUNDLED | null) =>
  jest
    .spyOn(Image, "resolveAssetSource")
    .mockReturnValue(source as ReturnType<typeof Image.resolveAssetSource>);

beforeEach(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "clearImmediate"],
  });
  jest
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation(
      (callback) => setTimeout(() => callback(Date.now()), FRAME_MS) as unknown as number,
    );
  jest
    .spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation((frame) => clearTimeout(frame as unknown as ReturnType<typeof setTimeout>));
  mapbox.mockSourceProps.mockClear();
  withAsset(BUNDLED);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("the van's model file", () => {
  const glb = readFileSync(MODEL_FILE);
  const words = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const text = (from: number, to: number) => String.fromCharCode(...glb.subarray(from, to));
  // A binary glTF: a 12-byte header, then the JSON chunk (its length, its kind, its text).
  const json = JSON.parse(text(20, 20 + words.getUint32(12, true))) as {
    materials: { name: string }[];
    accessors: { min?: number[]; max?: number[] }[];
  };

  it("is a small binary glTF, 5 m long on the ground, nose to +Z, in the brand's colors", () => {
    expect(text(0, 4)).toBe("glTF");
    expect(glb.length).toBeLessThan(1_000_000);
    expect(words.getUint32(8, true)).toBe(glb.length);
    expect(json.materials.map((material) => material.name)).toEqual(
      expect.arrayContaining(["body", "accent", "glass", "tire"]),
    );
    // The body: x across, y up from the ground clearance, z from the rear doors to the nose.
    const [body] = json.accessors;
    expect((body.max?.[2] ?? 0) - (body.min?.[2] ?? 0)).toBeCloseTo(5, 5);
    expect((body.max?.[0] ?? 0) - (body.min?.[0] ?? 0)).toBeCloseTo(2, 5);
    expect(body.min?.[1]).toBeGreaterThan(0);
  });

  it("is what the committed generator writes from the theme's tokens", () => {
    expect(() => execFileSync("node", [GENERATOR, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

describe("the van's model source", () => {
  it("is the bundled asset in a build", () => {
    expect(vanModelSource()).toBe(1);
  });

  it("is the development server's plain address of the file, ending in .glb", () => {
    withAsset(SERVED);
    expect(vanModelSource()).toBe("http://10.0.2.2:8081/assets/assets/models/van.glb");
  });

  it("is nothing when the app does not have the model", () => {
    withAsset(null);
    expect(vanModelSource()).toBeNull();
  });
});

describe("LiveMap's van", () => {
  it("draws the pro as the 3D model from its own source, at a readable size", async () => {
    await render(<LiveMap {...props()} />);
    expect(screen.getByTestId("mapbox-Models").props.models).toEqual({ "jack-van-model": 1 });
    const layer = screen.getByTestId(MODEL_LAYER);
    // In the pro's source, named in so many words (a boundary stands between them): the frames'
    // feature places and turns it.
    expect(layer.parent).toBe(screen.getByTestId("mapbox-ShapeSource-jack-van"));
    expect(layer.props.sourceID).toBe("jack-van");
    expect(layer.props.style).toMatchObject({
      modelId: "jack-van-model",
      modelType: "common-3d",
      modelRotation: ["get", "rotation"],
      // Its shadow painted a pale square over the arrow it stands on.
      modelCastShadows: false,
    });
    expect(layer.props.style.modelOpacity).toBe(1);
    // Its size comes from the feature too, never from a zoom expression in the style (the map
    // works those out at whole zoom levels only).
    expect(layer.props.style.modelScale).toEqual(["get", "scale"]);
    expect(lastVan().properties.scale).toEqual(vanScale(FOLLOW_ZOOM));
  });

  it("stands on the arrow, which never goes: nothing tells the app that the van drew", async () => {
    await render(<LiveMap {...props({ fix: fix(at(0, 100), 0, 90) })} />);
    const source = screen.getByTestId("mapbox-ShapeSource-jack-van");
    const arrow = screen.getByTestId(ARROW_LAYER);
    const model = screen.getByTestId(MODEL_LAYER);
    expect(arrow.parent).toBe(source);
    // The arrow sits in the map's top slot; the model, in none, is drawn above everything.
    expect(arrow.props.slot).toBe("top");
    expect(model.props.slot).toBeUndefined();
    // Both read the one feature the frames write: they turn and dim together.
    expect(arrow.props.style).toMatchObject({
      iconImage: "jack-van-arrow",
      iconRotate: ["get", "bearing"],
      iconOpacity: ["get", "opacity"],
    });
    expect(lastVan().properties).toMatchObject({ bearing: 90, rotation: [0, 0, 270], opacity: 1 });
    // No wait for a confirmation that cannot come: still there long after the map loaded.
    await act(async () => {
      screen.getByTestId("live-map-view").props.onDidFinishLoadingMap();
    });
    await advance(30_000);
    expect(screen.getByTestId(ARROW_LAYER)).toBeTruthy();
    expect(screen.getByTestId(MODEL_LAYER)).toBeTruthy();
  });

  it("keeps the arrow, moving, when the map takes the model's address and draws nothing", async () => {
    // The native failure the map does not report: a good address, then a file it cannot read.
    withAsset(SERVED);
    jest.spyOn(mapbox, "Models").mockImplementation(() => <></>);
    jest.spyOn(mapbox, "ModelLayer").mockImplementation(() => <></>);
    await render(<LiveMap {...props()} />);
    expect(screen.getByTestId("live-map-view")).toBeTruthy();
    expect(screen.getByTestId(ARROW_LAYER).parent).toBe(
      screen.getByTestId("mapbox-ShapeSource-jack-van"),
    );
    // The map goes on: the next fix glides the arrow there.
    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 200), POLL_MS, 0) })} />);
    await advance(POLL_MS + 2000);
    expect(distanceM(lastVan().geometry.coordinates, at(0, 200))).toBeLessThan(0.5);
    expect(screen.getByTestId(ARROW_LAYER)).toBeTruthy();
  });

  it("keeps an error thrown by the model's layer there: the model goes, map and arrow stay", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    // React reports every error a boundary catches by itself, text included (muted here): in the
    // app, this part's props hold no position. The boundary's own line is what this test reads.
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(mapbox, "ModelLayer").mockImplementation(() => {
      throw new TypeError("feature at -80.111,26.1193 has no rotation");
    });
    await render(<LiveMap {...props()} />);
    expect(screen.getByTestId("live-map-view")).toBeTruthy();
    expect(screen.getByTestId(ARROW_LAYER)).toBeTruthy();
    // The whole model goes, its registration too.
    expect(screen.queryByTestId("mapbox-Models")).toBeNull();
    // The boundary logs once, by the error's class: never its text (here, a position).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Van model failed: TypeError");
    // The map goes on.
    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 200), POLL_MS, 0) })} />);
    await advance(POLL_MS + 2000);
    expect(distanceM(lastVan().geometry.coordinates, at(0, 200))).toBeLessThan(0.5);
    expect(screen.getByTestId(ARROW_LAYER)).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps an error thrown by the model's registration there too: the layer goes with it", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(mapbox, "Models").mockImplementation(() => {
      throw new Error("model jack-van-model: bad address");
    });
    await render(<LiveMap {...props()} />);
    expect(screen.getByTestId("live-map-view")).toBeTruthy();
    expect(screen.getByTestId(ARROW_LAYER)).toBeTruthy();
    expect(screen.queryByTestId(MODEL_LAYER)).toBeNull();
    expect(warn).toHaveBeenCalledWith("Van model failed: Error");
  });

  it("is its real size from zoom 19.5 in, and twice as large for each level out of it", () => {
    expect(vanScale(19.5)).toEqual([1, 1, 1]);
    expect(vanScale(21)).toEqual([1, 1, 1]);
    expect(vanScale(18.5)).toEqual([2, 2, 2]);
    // The follow camera's zoom: eight times a real van, about as long as the arrow is wide.
    expect(vanScale(FOLLOW_ZOOM)).toEqual([8, 8, 8]);
    // Between two levels too: the same size on screen at 16 and at 17 as at 16.5.
    expect(vanScale(16)[0]).toBeCloseTo(8 * Math.SQRT2, 3);
    const onScreen = (zoom: number) => vanScale(zoom)[0] * 2 ** zoom;
    expect(onScreen(13) / onScreen(16.5)).toBeCloseTo(1, 3);
  });

  it("keeps its size on screen as the camera zooms: sized again where it stands", async () => {
    await render(<LiveMap {...props({ fix: fix(at(0, 100), 0, 90) })} />);
    mapbox.mockSourceProps.mockClear();
    // The overview, further out.
    await cameraAt(13);
    expect(vanWrites()).toHaveLength(1);
    expect(lastVan().properties).toMatchObject({ scale: vanScale(13), rotation: [0, 0, 270] });
    expect(vanScale(13)[0]).toBeCloseTo(64 * Math.SQRT2, 3);
    expect(distanceM(lastVan().geometry.coordinates, at(0, 100))).toBeLessThan(0.1);
    // A change of zoom nobody could see draws nothing; neither does a camera that only turns.
    await cameraAt(13.01);
    await cameraAt(13.01);
    expect(vanWrites()).toHaveLength(1);
    await cameraAt(13.5);
    expect(vanWrites()).toHaveLength(2);
    expect(lastVan().properties.scale).toEqual(vanScale(13.5));
    // The frames of a glide carry the camera's zoom as well.
    await screen.rerender(<LiveMap {...props({ fix: fix(at(0, 200), POLL_MS, 0) })} />);
    await advance(POLL_MS);
    expect(lastVan().properties.scale).toEqual(vanScale(13.5));
  });

  it("unwatched, only notes the camera's zoom: the first frame back has the right size", async () => {
    await render(<LiveMap {...props()} />);
    await screen.rerender(<LiveMap {...props({ active: false })} />);
    mapbox.mockSourceProps.mockClear();
    await cameraAt(14);
    expect(mapbox.mockSourceProps).not.toHaveBeenCalled();
    await screen.rerender(<LiveMap {...props()} />);
    await advance(FRAME_MS);
    expect(lastVan().properties.scale).toEqual(vanScale(14));
    expect(vanScale(14)).not.toEqual(vanScale(FOLLOW_ZOOM));
  });

  it("turns the model with the pro's heading: its nose, glTF's +Z, points that way", async () => {
    expect(vanRotation(0)).toEqual([0, 0, 180]);
    expect(vanRotation(90)).toEqual([0, 0, 270]);
    expect(vanRotation(270)).toEqual([0, 0, 90]);
    await render(<LiveMap {...props({ fix: fix(at(0, 100), 0, 90) })} />);
    expect(lastVan().properties).toMatchObject({ bearing: 90, rotation: [0, 0, 270] });
    expect(
      screen.getByTestId("mapbox-ShapeSource-jack-van").props.shape.properties.rotation,
    ).toEqual([0, 0, 270]);
  });

  it("turns the short way: from 350 to 10 degrees through north, never back round", async () => {
    await render(<LiveMap {...props({ fix: fix(at(0, 100), 0, 350) })} />);
    mapbox.mockSourceProps.mockClear();
    const next = at(50 * Math.sin(Math.PI / 18), 100 + 50 * Math.cos(Math.PI / 18));
    await screen.rerender(<LiveMap {...props({ fix: fix(next, POLL_MS, 10) })} />);
    await advance(POLL_MS + 2000);
    const bearings = vanWrites().map((write) => write.properties.bearing);
    expect(bearings.length).toBeGreaterThan(100);
    // 20 degrees in all, through 0: no frame points anywhere between 10 and 350.
    expect(bearings.every((bearing) => bearing >= 350 || bearing <= 10.5)).toBe(true);
    expect(bearings.at(-1)).toBeCloseTo(10, 0);
    expect(lastVan().properties.rotation[2]).toBeCloseTo(190, 0);
  });

  it("without a heading, points the way it drives: the last two positions", async () => {
    await render(<LiveMap {...props({ fix: fix(at(0, 100), 0) })} />);
    await screen.rerender(<LiveMap {...props({ fix: fix(at(100, 100), POLL_MS) })} />);
    await advance(POLL_MS + 2000);
    expect(distanceM(lastVan().geometry.coordinates, at(100, 100))).toBeLessThan(0.5);
    expect(lastVan().properties.bearing).toBeCloseTo(90, 0);
    expect(lastVan().properties.rotation[2]).toBeCloseTo(270, 0);
  });

  it("standing still without a heading, points the way the route goes on", async () => {
    await render(<LiveMap {...props({ fix: fix(at(200, 400), 0), route: route() })} />);
    expect(lastVan().properties.bearing).toBeCloseTo(90, 0);
    expect(lastVan().properties.rotation[2]).toBeCloseTo(270, 0);
  });

  it("dims the model while the position is old, without a frame", async () => {
    await render(<LiveMap {...props()} />);
    const fresh = screen.getByTestId(MODEL_LAYER).props.style;
    await screen.rerender(<LiveMap {...props({ stale: true })} />);
    expect(screen.getByTestId(MODEL_LAYER).props.style.modelOpacity).toBe(STALE_OPACITY);
    expect(STALE_OPACITY).toBeLessThan(1);
    // Fresh again: the opacity is set back in so many words (a key left out would keep the dim),
    // with the very same style object, so the layer is restyled only on the flip.
    await screen.rerender(<LiveMap {...props()} />);
    expect(screen.getByTestId(MODEL_LAYER).props.style.modelOpacity).toBe(1);
    expect(screen.getByTestId(MODEL_LAYER).props.style).toBe(fresh);
  });

  it("reads the model from the development server by its file name", async () => {
    withAsset(SERVED);
    await render(<LiveMap {...props()} />);
    expect(screen.getByTestId("mapbox-Models").props.models).toEqual({
      "jack-van-model": "http://10.0.2.2:8081/assets/assets/models/van.glb",
    });
    expect(screen.getByTestId(MODEL_LAYER)).toBeTruthy();
  });

  it("falls back to the arrow, on the same map, when the model cannot be had", async () => {
    withAsset(null);
    await render(<LiveMap {...props({ fix: fix(at(0, 100), 0, 90), stale: true })} />);
    expect(screen.getByTestId("live-map-view")).toBeTruthy();
    expect(screen.queryByTestId("mapbox-Models")).toBeNull();
    expect(screen.queryByTestId(MODEL_LAYER)).toBeNull();
    const arrow = screen.getByTestId(ARROW_LAYER);
    expect(arrow.parent).toBe(screen.getByTestId("mapbox-ShapeSource-jack-van"));
    expect(arrow.props.style).toMatchObject({
      iconImage: "jack-van-arrow",
      iconRotate: ["get", "bearing"],
      iconOpacity: ["get", "opacity"],
    });
    // The arrow turns and dims from the same feature the frames write.
    expect(lastVan().properties).toMatchObject({ bearing: 90, opacity: STALE_OPACITY });
  });
});
