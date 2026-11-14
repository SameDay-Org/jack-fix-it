import {
  Camera,
  CameraGestureObserver,
  Image as MapImage,
  Images,
  LineLayer,
  MapView,
  setAccessToken,
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
  followPadding,
  followStop,
  OVERVIEW_HOLD_MS,
  overviewStop,
  REDUCED_MOTION_MS,
} from "./camera";
import { liveMapConfig } from "./config";
import { measurePath, normalizeDeg, towardDeg, type LngLat, type MeasuredPath } from "./geo";
import { routeAhead, sampleGlide, type Fix, type Glide, type VanPose } from "./motion";
import { useVanMotion, type VanFrame } from "./useVanMotion";

if (liveMapConfig.accessToken) void setAccessToken(liveMapConfig.accessToken);

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
const STALE_OPACITY = 0.45;
const VAN_SOURCE = "jack-van";
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

const pointFeature = (point: LngLat, properties: Record<string, number> = {}) => ({
  type: "Feature" as const,
  geometry: { type: "Point" as const, coordinates: [point[0], point[1]] },
  properties,
});

/** The van as the map draws it: where it is, the way it points, dimmed while the fix is old. */
const vanFeature = (pose: VanPose, stale: boolean) =>
  pointFeature(pose.point, { bearing: pose.bearing, opacity: stale ? STALE_OPACITY : 1 });

/** The van written straight to its native source (GeoJSON text, as the source takes it). */
const vanShape = (pose: VanPose, stale: boolean) => JSON.stringify(vanFeature(pose, stale));

export type LiveMapProps = {
  /** The pro's newest position (the last one known when the API stopped sending them). */
  fix: Fix;
  /** The position is old: the van dims. */
  stale: boolean;
  route: JobRoute | null;
  height: number;
  /** The cards over the map's bottom edge, beside the Recenter control. */
  cards: ReactNode;
  /** The map could not load its style (offline at first load): the caller shows its placeholder. */
  onUnavailable: () => void;
};

/**
 * The live map of the pro on the way (#353): Mapbox Standard with the city's names, landmarks and
 * 3D buildings, the route ahead in lime and the pro gliding along it from fix to fix (drawn by
 * `useVanMotion` straight to the native source, never through React). The camera first fits the
 * pro and the address, then follows the pro tilted like a navigation app, turning with them the
 * short way round; while the pro is more than `FAR_M` away it keeps the overview. A pan, pinch or
 * rotate frees the camera until Recenter. The map itself is not read out: the cards' summary is.
 */
export function LiveMap({ fix, stale, route, height, cards, onUnavailable }: LiveMapProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const lightPreset = useColorScheme() === "dark" ? "night" : "day";
  const { width } = useWindowDimensions();
  const camera = useRef<ComponentRef<typeof Camera>>(null);
  const van = useRef<ShapeSource>(null);
  const pose = useRef<VanPose | null>(null);
  // The camera's heading, from the map's own reports and what was last asked of it.
  const heading = useRef<number | null>(null);
  // The glide the camera follows and when its next step is due: a new glide re-aims at once.
  const followed = useRef<Glide | null>(null);
  const nextStep = useRef(0);
  const [overlay, setOverlay] = useState(0);
  const covered = SHEET_OVERLAP + OVERLAY_GAP + overlay;
  const padding = followPadding(height, covered);

  const path = useMemo(() => (route ? measurePath(route.geometry) : null), [route]);
  const trail = useTrail(fix, path);
  const far = route !== null && route.distance_m > FAR_M;
  const [loaded, setLoaded] = useState(false);
  const [holding, setHolding] = useState(trail.destination !== null);
  const [free, setFree] = useState(false);
  const mode: CameraMode = free ? "free" : holding || far ? "overview" : "follow";

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
  const showOverview = (point: LngLat, duration: number) => {
    if (trail.destination === null) return;
    heading.current = 0;
    camera.current?.setCamera(
      overviewStop([point, trail.destination], { width, height }, covered, duration),
    );
  };

  // Each frame draws the van; while following, the camera moves on to where the van will be.
  const onFrame = ({ pose: next, glide, now }: VanFrame) => {
    pose.current = next;
    van.current?.setNativeProps({ id: VAN_SOURCE, shape: vanShape(next, stale) });
    if (mode !== "follow" || (glide === followed.current && now < nextStep.current)) return;
    followed.current = glide;
    const step = reduceMotion ? REDUCED_MOTION_MS : CAMERA_STEP_MS;
    const ahead = sampleGlide(glide, now + step);
    moveTo(ahead.point, ahead.heading, step, reduceMotion ? "easeTo" : "linearTo");
    nextStep.current = now + step;
  };
  useVanMotion(
    fix,
    trail.routes,
    reduceMotion ? REDUCED_MOTION_MS : liveMapConfig.pollMs,
    reduceMotion,
    onFrame,
  );

  // Each mode moves the camera there, once the map has loaded: before that the map has no size to
  // fit an overview to (Android fits the default settings' bounds too early). The first move is
  // instant, every later one eases.
  const applyMode = useEffectEvent((next: CameraMode, first: boolean) => {
    const at = pose.current;
    if (at === null) return;
    const duration = first ? 0 : reduceMotion ? REDUCED_MOTION_MS : CAMERA_TRANSITION_MS;
    if (next === "follow") {
      moveTo(at.point, at.bearing, duration, first ? "none" : "easeTo");
      nextStep.current = Date.now() + duration;
    } else if (next === "overview") {
      showOverview(at.point, duration);
    }
  });
  const placedFor = useRef<CameraMode | null>(null);
  useEffect(() => {
    if (!loaded || placedFor.current === mode) return;
    const first = placedFor.current === null;
    placedFor.current = mode;
    applyMode(mode, first);
  }, [loaded, mode]);

  // The overview follows each new fix.
  const refitOverview = useEffectEvent(() => {
    if (loaded && mode === "overview") showOverview(fix.point, CAMERA_TRANSITION_MS);
  });
  useEffect(() => refitOverview(), [fix.at]);

  // The first overview is brief: it gives way to the follow camera once the map has loaded.
  useEffect(() => {
    if (!loaded || !holding) return;
    const timer = setTimeout(() => setHolding(false), OVERVIEW_HOLD_MS);
    return () => clearTimeout(timer);
  }, [holding, loaded]);

  const restyle = useEffectEvent(() => {
    if (pose.current === null) return;
    van.current?.setNativeProps({ id: VAN_SOURCE, shape: vanShape(pose.current, stale) });
  });
  useEffect(() => restyle(), [stale]);

  const [initial] = useState(() => ({
    van: vanFeature({ point: fix.point, bearing: fix.heading ?? 0 }, stale),
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
          if (error?.type === "style") onUnavailable();
        }}
        testID="live-map-view"
      >
        <StyleImport id="basemap" existing config={{ ...STANDARD_CONFIG, lightPreset }} />
        <Camera ref={camera} defaultSettings={initial.camera} />
        <CameraGestureObserver
          onCameraChanged={({ nativeEvent }) => {
            heading.current = nativeEvent.properties.heading;
            if (nativeEvent.properties.isUserInteraction && !free) setFree(true);
          }}
        />
        <MapGlyphs />
        {trail.ahead ? (
          <ShapeSource
            id="jack-route"
            shape={{
              type: "Feature",
              geometry: { type: "LineString", coordinates: trail.ahead.map((p) => [p[0], p[1]]) },
              properties: {},
            }}
          >
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
        <VanLayer ref={van} shape={initial.van} />
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
 * The route still ahead (from the fix before the newest, where the van starts its glide, so it
 * drives on the line), the address at its end (kept while the route is briefly unavailable),
 * and the newest two routes for `planGlide`: a fix can still lie on the one before a recomputed one.
 */
function useTrail(fix: Fix, path: MeasuredPath | null) {
  const [trail, setTrail] = useState({
    at: fix.at,
    last: fix.point,
    from: fix.point,
    path,
    previous: null as MeasuredPath | null,
    destination: (path?.points.at(-1) ?? null) as LngLat | null,
  });
  if (trail.at !== fix.at || trail.path !== path) {
    const moved = trail.at !== fix.at;
    setTrail({
      at: fix.at,
      last: fix.point,
      from: moved ? trail.last : trail.from,
      path,
      previous: trail.path !== path ? (trail.path ?? trail.previous) : trail.previous,
      destination: path?.points.at(-1) ?? trail.destination,
    });
  }
  return useMemo(
    () => ({
      routes: [trail.path, trail.previous] as const,
      ahead: trail.path ? routeAhead(trail.path, trail.previous, trail.from) : null,
      destination: trail.destination,
    }),
    [trail],
  );
}

/** The van, drawn from the native source `useVanMotion` writes to; React never redraws it. */
const VanLayer = memo(function VanLayer({
  ref,
  shape,
}: {
  ref: Ref<ShapeSource>;
  shape: ReturnType<typeof vanFeature>;
}) {
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
