import {
  Camera,
  CameraGestureObserver,
  Image as MapImage,
  Images,
  LineLayer,
  MapView,
  ModelLayer,
  setAccessToken,
  setTelemetryEnabled,
  ShapeSource,
  StyleImport,
  SymbolLayer,
  type CameraAnimationMode,
  type LineLayerStyle,
} from "@rnmapbox/maps";
import {
  memo,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, useColorScheme, useWindowDimensions, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { ControlIcon } from "@/components/icons";
import { GlassSurface } from "@/components/ui";
import { tokens } from "@/theme";

import { SHEET_OVERLAP } from "../JobChrome";
import { HOUSE_PATH } from "../JobMap";

import type { JobRoute } from "./api";
import {
  CAMERA_STEP_MS,
  CAMERA_TRANSITION_MS,
  FAR_M,
  FOLLOW_ZOOM,
  followPadding,
  followStop,
  OVERVIEW_HOLD_MS,
  OVERVIEW_WINDOW_MS,
  overviewStop,
  REDUCED_MOTION_MS,
} from "./camera";
import { liveMapConfig } from "./config";
import {
  distanceM,
  measurePath,
  normalizeDeg,
  towardDeg,
  type LngLat,
  type MeasuredPath,
} from "./geo";
import { routeAhead, sampleGlide, type Fix, type Glide, type VanPose } from "./motion";
import { useVanMotion, type VanFrame } from "./useVanMotion";
import {
  STALE_OPACITY,
  VanModelAsset,
  vanModelSource,
  vanModelStyle,
  vanRotation,
  vanScale,
} from "./VanModel";

// Once, before any map is drawn: the token, then Mapbox's usage and location telemetry off.
// What still leaves the phone for Mapbox, by design: the SDK's turnstile event (it counts monthly
// active users for billing, carries no location, and the SDK has no switch for it), and the
// requests for the style, tiles, glyphs and 3D models, whose tile ids tell Mapbox which area is
// on screen. The pro's position, the route and the customer's address are only this map's own
// source data: they come from our API, go to no other endpoint, and are never logged.
if (liveMapConfig.accessToken) {
  void setAccessToken(liveMapConfig.accessToken);
  setTelemetryEnabled(false);
}

/** Mapbox Standard: streets and their names, places, landmarks and 3D buildings. */
export const STANDARD_STYLE_URL = "mapbox://styles/mapbox/standard";
/** Everything Standard can show of the city stays on: the customer finds their way by it. */
export const STANDARD_CONFIG = {
  showRoadLabels: true,
  showPlaceLabels: true,
  showPointOfInterestLabels: true,
  showTransitLabels: true,
  show3dObjects: true,
  show3dBuildings: true,
  show3dLandmarks: true,
} as const;

// The overlay row sits this far above the sheet's top edge.
const OVERLAY_GAP = 12;
// The Mapbox wordmark and attribution sit just above the overlay row, where they stay visible.
const ORNAMENT_GAP = 4;
const ORNAMENT_SIDE = 16;
const VAN_SOURCE = "jack-van";
const ROUTE_SOURCE = "jack-route";
/** The van is sized again once the camera's zoom moved this much (about 1 % of its size). */
const ZOOM_STEP = 0.02;
/** While the van glides, the route's line is cut back to it this often (and where it stops). */
export const ROUTE_TRIM_MS = 200;
/** Two rests of the van closer than this are the same place: the line is not drawn again. */
const SAME_REST_M = 0.05;
const ARROW = 36;
const ARROW_RIM = 3;
const ARROW_GLYPH = 18;
const ARROW_PATH = "M12 3l7 17-7-4-7 4z";
const PIN = 34;
const PIN_RIM = 3;
const PIN_GLYPH = 18;
const RECENTER = 48;
const RECENTER_GLYPH = 22;
const ROUTE_WIDTH: LineLayerStyle["lineWidth"] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  12,
  3,
  16,
  7,
  19,
  14,
];
const CASING_WIDTH: LineLayerStyle["lineWidth"] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  12,
  5,
  16,
  11,
  19,
  20,
];

const { colors } = tokens;

type CameraMode = "overview" | "follow" | "free";

const pointFeature = (point: LngLat, properties: Record<string, number | number[]> = {}) => ({
  type: "Feature" as const,
  geometry: { type: "Point" as const, coordinates: [point[0], point[1]] },
  properties,
});

/** The van as the map draws it: where it is, the way it points, dimmed while the fix is old. */
const vanFeature = (pose: VanPose, stale: boolean, zoom: number) =>
  pointFeature(pose.point, {
    bearing: pose.bearing,
    rotation: vanRotation(pose.bearing),
    scale: vanScale(zoom),
    opacity: stale ? STALE_OPACITY : 1,
  });

/** The van written straight to its native source (GeoJSON text, as the source takes it). */
const vanShape = (pose: VanPose, stale: boolean, zoom: number) =>
  JSON.stringify(vanFeature(pose, stale, zoom));

const lineFeature = (points: readonly LngLat[]) => ({
  type: "Feature" as const,
  geometry: { type: "LineString" as const, coordinates: points.map((p) => [p[0], p[1]]) },
  properties: {},
});

export type LiveMapProps = {
  /** The pro's newest position (the last one known when the API stopped sending them). */
  fix: Fix;
  /** The position is old: the van dims. */
  stale: boolean;
  /**
   * The map is being watched (screen focused, app in the foreground, pro on the way): only then
   * does the van move. The same condition asks for the positions (`useLiveTracking`).
   */
  active: boolean;
  route: JobRoute | null;
  height: number;
  /** The cards over the map's bottom edge, beside the Recenter control. */
  cards: ReactNode;
  /** The map could not load its style (offline at first load): the caller shows its placeholder. */
  onUnavailable: () => void;
};

/**
 * The live map of the pro on the way (#353): Mapbox Standard with the city's names, landmarks and
 * 3D buildings, the route ahead in lime (it starts where the pro is drawn) and the pro gliding
 * along it from fix to fix (both drawn by `useVanMotion`'s frames straight to the native sources,
 * never through React state per frame). The camera first fits the pro and the address, then
 * follows the pro tilted like a navigation app, turning with them the short way round; while the
 * pro is more than `FAR_M` away it keeps the overview. A pan, pinch or
 * rotate frees the camera until Recenter. The map itself is not read out: the cards' summary is.
 */
export function LiveMap({ fix, stale, active, route, height, cards, onUnavailable }: LiveMapProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const lightPreset = useColorScheme() === "dark" ? "night" : "day";
  const { width } = useWindowDimensions();
  const camera = useRef<ComponentRef<typeof Camera>>(null);
  const van = useRef<ShapeSource>(null);
  const line = useRef<ShapeSource>(null);
  const pose = useRef<VanPose | null>(null);
  // The camera's zoom as the map last reported it: the van's size on screen follows it.
  const zoom = useRef(FOLLOW_ZOOM);
  // The camera's heading, from the map's own reports and what was last asked of it.
  const heading = useRef<number | null>(null);
  // The glide the van is on, the one the camera follows, and when the camera's next step is due:
  // a new glide re-aims at once.
  const gliding = useRef<Glide | null>(null);
  const followed = useRef<Glide | null>(null);
  const nextStep = useRef(0);
  const [overlay, setOverlay] = useState(0);
  const covered = SHEET_OVERLAP + OVERLAY_GAP + overlay;
  const padding = followPadding(height, covered);

  const path = useMemo(() => (route ? measurePath(route.geometry) : null), [route]);
  const trail = useTrail(path);
  // Where the van last came to rest: React's own copy of the line starts there. Between two
  // rests the frames cut the line back to the van in the native source.
  const [rest, setRest] = useState<LngLat>(fix.point);
  const ahead = useMemo(
    () => (trail.path ? routeAhead(trail.path, trail.previous, rest) : null),
    [trail, rest],
  );
  const trim = useRef({
    glide: null as Glide | null,
    ended: null as Glide | null,
    path: null as MeasuredPath | null,
    next: 0,
  });
  // Every camera move that eases takes this long.
  const transitionMs = reduceMotion ? REDUCED_MOTION_MS : CAMERA_TRANSITION_MS;
  const [loaded, setLoaded] = useState(false);
  // The pro is a 3D van; without its model, the arrow.
  const [vanModel] = useState(vanModelSource);
  // The first overview: on once the address is known (at mount or soon after the map loads).
  const [hold, setHold] = useState<"waiting" | "on" | "done">(
    trail.destination !== null ? "on" : "waiting",
  );
  if (hold === "waiting" && trail.destination !== null) setHold("on");
  // Far as the last route said: a route briefly unavailable (503, being computed) changes nothing.
  const [far, setFar] = useState(route !== null && route.distance_m > FAR_M);
  if (route !== null && route.distance_m > FAR_M !== far) setFar(!far);
  const [free, setFree] = useState(false);
  const mode: CameraMode = free ? "free" : hold === "on" || far ? "overview" : "follow";

  // The camera turns from where it points now to the van's heading the short way round.
  const moveTo = (
    point: LngLat,
    bearing: number,
    duration: number,
    animation: CameraAnimationMode,
  ) => {
    const next = towardDeg(heading.current ?? bearing, bearing);
    heading.current = normalizeDeg(next);
    camera.current?.setCamera(followStop(point, next, padding, duration, animation));
  };
  // The overview fits where the van is drawn, the newest fix it glides to, and the address.
  const showOverview = (duration: number) => {
    if (trail.destination === null) return;
    const points = [fix.point, trail.destination, ...(pose.current ? [pose.current.point] : [])];
    heading.current = 0;
    camera.current?.setCamera(overviewStop(points, { width, height }, covered, duration));
  };

  // The line starts at the van: cut back as a glide starts, every ROUTE_TRIM_MS during it, where
  // it ends (React then takes the line over from there) and when the route itself changes.
  const trimRoute = ({ pose: next, glide, now, arrived }: VanFrame) => {
    const state = trim.current;
    const same = state.path === trail.path;
    const waits = !arrived && state.glide === glide && now < state.next;
    if (same && (state.ended === glide || waits)) return;
    Object.assign(state, { glide, path: trail.path, next: now + ROUTE_TRIM_MS });
    if (trail.path) {
      const points = routeAhead(trail.path, trail.previous, next.point);
      line.current?.setNativeProps({
        id: ROUTE_SOURCE,
        shape: JSON.stringify(lineFeature(points)),
      });
    }
    if (!arrived) return;
    state.ended = glide;
    setRest((was) => (distanceM(was, next.point) < SAME_REST_M ? was : next.point));
  };

  // Each frame draws the van and the line from it; while following, the camera moves on to where
  // the van will be.
  const onFrame = (frame: VanFrame) => {
    const { pose: next, glide, now } = frame;
    pose.current = next;
    gliding.current = glide;
    van.current?.setNativeProps({ id: VAN_SOURCE, shape: vanShape(next, stale, zoom.current) });
    trimRoute(frame);
    if (mode !== "follow" || (glide === followed.current && now < nextStep.current)) return;
    followed.current = glide;
    const step = reduceMotion ? REDUCED_MOTION_MS : CAMERA_STEP_MS;
    const ahead = sampleGlide(glide, now + step);
    moveTo(ahead.point, ahead.heading, step, reduceMotion ? "easeTo" : "linearTo");
    nextStep.current = now + step;
  };
  useVanMotion(
    fix,
    [trail.path, trail.previous],
    reduceMotion ? REDUCED_MOTION_MS : liveMapConfig.pollMs,
    reduceMotion,
    active,
    onFrame,
  );

  // Each mode moves the camera there, once the map has loaded: before that the map has no size to
  // fit an overview to (Android fits the default settings' bounds too early). The first move is
  // instant, every later one eases.
  const applyMode = useEffectEvent((next: CameraMode, first: boolean) => {
    const at = pose.current;
    if (at === null) return;
    const duration = first ? 0 : transitionMs;
    if (next === "follow") {
      moveTo(at.point, at.bearing, duration, first ? "none" : "easeTo");
      // The frames take over once this move is done, even in the middle of a glide.
      followed.current = gliding.current;
      nextStep.current = Date.now() + duration;
    } else if (next === "overview") {
      showOverview(duration);
    }
  });
  // A map nobody watches keeps its camera: the mode it should be in is placed on the way back.
  const placedFor = useRef<CameraMode | null>(null);
  useEffect(() => {
    if (!loaded || !active || placedFor.current === mode) return;
    const first = placedFor.current === null;
    placedFor.current = mode;
    applyMode(mode, first);
  }, [active, loaded, mode]);

  // The overview follows each new fix, and fits again when the map is watched again.
  const refitOverview = useEffectEvent(() => {
    if (loaded && active && mode === "overview") showOverview(transitionMs);
  });
  useEffect(() => refitOverview(), [fix.at, active]);

  // The first overview is brief: it gives way to the follow camera after OVERVIEW_HOLD_MS. It is
  // only for the first load: an address first known later than OVERVIEW_WINDOW_MS after it
  // leaves the camera as it is.
  useEffect(() => {
    if (!loaded || hold === "done") return;
    const timer = setTimeout(
      () => setHold("done"),
      hold === "on" ? OVERVIEW_HOLD_MS : OVERVIEW_WINDOW_MS,
    );
    return () => clearTimeout(timer);
  }, [hold, loaded]);

  // The van drawn again where it stands, as it should look now. A map nobody watches is left
  // alone: its first frame back draws the van as it should look by then.
  const redraw = () => {
    if (!active || pose.current === null) return;
    van.current?.setNativeProps({
      id: VAN_SOURCE,
      shape: vanShape(pose.current, stale, zoom.current),
    });
  };
  // It keeps its size on screen as the camera zooms, for each step of zoom one could see.
  const rescale = (at: number) => {
    if (!(Math.abs(at - zoom.current) >= ZOOM_STEP)) return;
    zoom.current = at;
    redraw();
  };
  // It dims and lights up again with the age of its position.
  const restyle = useEffectEvent(redraw);
  useEffect(() => restyle(), [stale]);

  // Unwatched in the middle of a glide, the frames stop cutting the line: React's own copy takes
  // it over from where the van stands, so a route that still lands is drawn from there.
  const settle = useEffectEvent(() => {
    const at = pose.current;
    if (active || at === null) return;
    setRest((was) => (distanceM(was, at.point) < SAME_REST_M ? was : at.point));
  });
  useEffect(() => settle(), [active]);

  const [initial] = useState(() => ({
    van: vanFeature({ point: fix.point, bearing: fix.heading ?? 0 }, stale, FOLLOW_ZOOM),
    camera: followStop(fix.point, fix.heading ?? 0, padding, 0, "none"),
  }));

  return (
    <View style={{ height }} testID="live-map">
      <MapView
        style={{ flex: 1 }}
        styleURL={STANDARD_STYLE_URL}
        accessible={false}
        compassEnabled={false}
        scaleBarEnabled={false}
        pitchEnabled
        rotateEnabled
        requestDisallowInterceptTouchEvent={Platform.OS === "android"}
        logoPosition={{ bottom: covered + ORNAMENT_GAP, left: ORNAMENT_SIDE }}
        attributionPosition={{ bottom: covered + ORNAMENT_GAP, right: ORNAMENT_SIDE }}
        onDidFinishLoadingMap={() => setLoaded(true)}
        onMapLoadingError={(error) => {
          // Once loaded the map keeps its style: a later report (offline tiles) changes nothing.
          if (error?.type === "style" && !loaded) onUnavailable();
        }}
        testID="live-map-view"
      >
        <StyleImport id="basemap" existing config={{ ...STANDARD_CONFIG, lightPreset }} />
        <Camera ref={camera} defaultSettings={initial.camera} />
        <CameraGestureObserver
          onCameraChanged={({ nativeEvent }) => {
            heading.current = nativeEvent.properties.heading;
            rescale(nativeEvent.properties.zoom);
            if (nativeEvent.properties.isUserInteraction && !free) setFree(true);
          }}
        />
        <MapGlyphs />
        {vanModel === null ? null : <VanModelAsset source={vanModel} />}
        {ahead ? (
          <ShapeSource ref={line} id={ROUTE_SOURCE} shape={lineFeature(ahead)}>
            <LineLayer
              id="jack-route-casing"
              slot="middle"
              style={{
                lineColor: colors["green-700"],
                lineWidth: CASING_WIDTH,
                lineCap: "round",
                lineJoin: "round",
                lineEmissiveStrength: 1,
              }}
            />
            <LineLayer
              id="jack-route-line"
              slot="middle"
              style={{
                lineColor: colors["green-500"],
                lineWidth: ROUTE_WIDTH,
                lineCap: "round",
                lineJoin: "round",
                lineEmissiveStrength: 1,
              }}
            />
          </ShapeSource>
        ) : null}
        {trail.destination ? (
          <ShapeSource id="jack-destination" shape={pointFeature(trail.destination)}>
            <SymbolLayer
              id="jack-destination-pin"
              slot="top"
              style={{
                iconImage: "jack-destination",
                iconAllowOverlap: true,
                iconIgnorePlacement: true,
                iconPitchAlignment: "viewport",
              }}
            />
          </ShapeSource>
        ) : null}
        <VanLayer ref={van} shape={initial.van} model={vanModel !== null} stale={stale} />
      </MapView>
      <View
        pointerEvents="box-none"
        className="absolute left-4 right-4 flex-row items-end gap-3"
        style={{ bottom: SHEET_OVERLAP + OVERLAY_GAP }}
        onLayout={(event) => setOverlay(event.nativeEvent.layout.height)}
      >
        <View className="flex-1">{cards}</View>
        {free ? (
          <Recenter label={t("jobs.liveMap.recenter")} onPress={() => setFree(false)} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * The newest route, the one before it (a fix, or the van, can still lie on the one before a
 * recomputed one) and the address at the route's end, kept while the route is briefly unavailable.
 */
function useTrail(path: MeasuredPath | null) {
  const [trail, setTrail] = useState({
    path,
    previous: null as MeasuredPath | null,
    destination: (path?.points.at(-1) ?? null) as LngLat | null,
  });
  if (trail.path !== path) {
    setTrail({
      path,
      previous: trail.path ?? trail.previous,
      destination: path?.points.at(-1) ?? trail.destination,
    });
  }
  return trail;
}

/** The van, drawn from the native source `useVanMotion` writes to; React never redraws it. */
const VanLayer = memo(function VanLayer({
  ref,
  shape,
  model,
  stale,
}: {
  ref: Ref<ShapeSource>;
  shape: ReturnType<typeof vanFeature>;
  /** Draw the 3D van; false draws the arrow instead. */
  model: boolean;
  /** The position is old: the van dims (the arrow reads that from its feature). */
  stale: boolean;
}) {
  if (model) {
    return (
      <ShapeSource ref={ref} id={VAN_SOURCE} shape={shape}>
        <ModelLayer id="jack-van-model" style={vanModelStyle(stale)} />
      </ShapeSource>
    );
  }
  return (
    <ShapeSource ref={ref} id={VAN_SOURCE} shape={shape}>
      <SymbolLayer
        id="jack-van-arrow"
        slot="top"
        style={{
          iconImage: "jack-van-arrow",
          iconRotate: ["get", "bearing"],
          iconOpacity: ["get", "opacity"],
          iconRotationAlignment: "map",
          iconPitchAlignment: "map",
          iconAllowOverlap: true,
          iconIgnorePlacement: true,
        }}
      />
    </ShapeSource>
  );
});

/**
 * The map's own pictures, drawn from views: the pro's arrow and the address's pin. Each image
 * takes exactly one view: its root must not be flattened into its children.
 */
const MapGlyphs = memo(function MapGlyphs() {
  return (
    <Images>
      <MapImage name="jack-van-arrow">
        <View
          collapsable={false}
          className="items-center justify-center rounded-pill bg-green-500"
          style={{ width: ARROW, height: ARROW }}
        >
          <View
            className="items-center justify-center rounded-pill bg-navy-900"
            style={{ width: ARROW - 2 * ARROW_RIM, height: ARROW - 2 * ARROW_RIM }}
          >
            <Svg width={ARROW_GLYPH} height={ARROW_GLYPH} viewBox="0 0 24 24">
              <Path d={ARROW_PATH} fill={colors.white} />
            </Svg>
          </View>
        </View>
      </MapImage>
      <MapImage name="jack-destination">
        <View
          collapsable={false}
          className="items-center justify-center rounded-pill bg-white"
          style={{ width: PIN, height: PIN }}
        >
          <View
            className="items-center justify-center rounded-pill bg-navy-900"
            style={{ width: PIN - 2 * PIN_RIM, height: PIN - 2 * PIN_RIM }}
          >
            <Svg width={PIN_GLYPH} height={PIN_GLYPH} viewBox="0 0 24 24">
              <Path d={HOUSE_PATH} fill={colors.white} />
            </Svg>
          </View>
        </View>
      </MapImage>
    </Images>
  );
});

/** The round control that hands the camera back to following the pro. */
function Recenter({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <GlassSurface tone="light" shape="pill" interactive>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        className="items-center justify-center"
        style={{ width: RECENTER, height: RECENTER }}
        testID="live-map-recenter"
      >
        <ControlIcon name="locate" size={RECENTER_GLYPH} color={colors["navy-900"]} />
      </Pressable>
    </GlassSurface>
  );
}
