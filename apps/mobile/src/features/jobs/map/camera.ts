import type { CameraAnimationMode, CameraPadding, CameraStop } from "@rnmapbox/maps";

import type { LngLat } from "./geo";

/** The navigation camera: close enough for street names, tilted like a driving app. */
export const FOLLOW_ZOOM = 16.5;
export const FOLLOW_PITCH = 58;
/** The overview of the pro and the address, tilted less so both fit. */
export const OVERVIEW_PITCH = 40;
/** Past this many meters to drive, the camera keeps the overview instead of following. */
export const FAR_M = 3000;
/** The overview shown first, before the camera starts to follow the van. */
export const OVERVIEW_HOLD_MS = 1800;
/** An address first known this long after the map loaded (a route that came late) gets none. */
export const OVERVIEW_WINDOW_MS = 12_000;
/** While following, the camera moves on to where the van will be this much later. */
export const CAMERA_STEP_MS = 1000;
/** A change of camera mode (to follow, to the overview) eases over this long. */
export const CAMERA_TRANSITION_MS = 1200;
/** Under Reduce Motion no glide or camera move lasts longer than this. */
export const REDUCED_MOTION_MS = 300;

// The overview keeps the pins clear of the round way back above, the map's edges, and Mapbox's
// wordmark and attribution just above the cards (a pin is drawn around its point).
const OVERVIEW_TOP = 64;
const OVERVIEW_SIDE = 40;
const OVERVIEW_BOTTOM_GAP = 44;

/**
 * Padding that puts the followed van two thirds of the way down the map's open part (above the
 * cards), so more of the road ahead shows above it.
 */
export function followPadding(height: number, covered: number): CameraPadding {
  const open = Math.max(0, height - covered);
  return { paddingTop: open / 3, paddingBottom: covered, paddingLeft: 0, paddingRight: 0 };
}

/** The camera on the van, its heading the van's (already unwrapped by the caller). */
export function followStop(
  point: LngLat,
  heading: number,
  padding: CameraPadding,
  animationDuration: number,
  animationMode: CameraAnimationMode,
): CameraStop {
  return {
    centerCoordinate: [point[0], point[1]],
    zoomLevel: FOLLOW_ZOOM,
    pitch: FOLLOW_PITCH,
    heading,
    padding,
    animationDuration,
    animationMode,
  };
}

// Web Mercator at zoom 0: the world is 512 units wide (Mapbox's tile size).
const WORLD = 512;
const toWorld = ([lng, lat]: LngLat): [number, number] => {
  const sin = Math.sin((lat * Math.PI) / 180);
  return [
    ((lng + 180) / 360) * WORLD,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * WORLD,
  ];
};
const fromWorld = (x: number, y: number): LngLat => {
  const n = Math.PI - (2 * Math.PI * y) / WORLD;
  return [(x / WORLD) * 360 - 180, (Math.atan(Math.sinh(n)) * 180) / Math.PI];
};
/** The overview's paddings never leave less than this share of the map's height to fit into. */
const OVERVIEW_MIN_ROOM = 0.4;
/** The overview zooms out this much more than a flat fit: the tilt brings the near edge closer. */
const TILT_MARGIN = 0.25;
/** Two points close together never zoom the overview in past this. */
const OVERVIEW_MAX_ZOOM = 15;

/**
 * The camera fitting every point (the van and the address), north up, tilted a little. Worked out
 * here rather than with the camera's `bounds`: the SDK fits bounds inside the map's current
 * padding (the follow camera's) as well as the given one, which leaves no room on a short map.
 */
export function overviewStop(
  points: readonly LngLat[],
  size: { width: number; height: number },
  covered: number,
  animationDuration: number,
): CameraStop {
  const world = points.map(toWorld);
  const xs = world.map(([x]) => x);
  const ys = world.map(([, y]) => y);
  // Large text makes the cards tall. The paddings never take more than (1 - OVERVIEW_MIN_ROOM) of
  // the map: the top gives way first, then the gap above the cards, the cards' own height last,
  // so the pins stay clear of the cards as long as anything can.
  const most = size.height * (1 - OVERVIEW_MIN_ROOM);
  const spare = Math.max(0, most - covered);
  const gap = Math.min(OVERVIEW_BOTTOM_GAP, spare);
  const padding = {
    paddingTop: Math.min(OVERVIEW_TOP, spare - gap),
    paddingBottom: Math.min(covered, most) + gap,
    paddingLeft: OVERVIEW_SIDE,
    paddingRight: OVERVIEW_SIDE,
  };
  const room = {
    width: Math.max(1, size.width - padding.paddingLeft - padding.paddingRight),
    height: Math.max(1, size.height - padding.paddingTop - padding.paddingBottom),
  };
  const span = {
    width: Math.max(Number.EPSILON, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(Number.EPSILON, Math.max(...ys) - Math.min(...ys)),
  };
  const fit = Math.log2(Math.min(room.width / span.width, room.height / span.height));
  const center = fromWorld(
    (Math.max(...xs) + Math.min(...xs)) / 2,
    (Math.max(...ys) + Math.min(...ys)) / 2,
  );
  return {
    centerCoordinate: [center[0], center[1]],
    zoomLevel: Math.min(OVERVIEW_MAX_ZOOM, fit - TILT_MARGIN),
    pitch: OVERVIEW_PITCH,
    heading: 0,
    padding,
    animationDuration,
    animationMode: "easeTo",
  };
}
