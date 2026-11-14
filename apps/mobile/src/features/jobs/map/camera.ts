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
/** While following, the camera moves on to where the van will be this much later. */
export const CAMERA_STEP_MS = 1000;
/** A change of camera mode (to follow, to the overview) eases over this long. */
export const CAMERA_TRANSITION_MS = 1200;
/** Under Reduce Motion no glide or camera move lasts longer than this. */
export const REDUCED_MOTION_MS = 300;

// The overview keeps the pins clear of the round way back above, the map's edges, and Mapbox's
// wordmark and attribution just above the cards (a pin is drawn around its point).
const OVERVIEW_TOP = 80;
const OVERVIEW_SIDE = 56;
const OVERVIEW_BOTTOM_GAP = 56;

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

/** The camera fitting every point (the van and the address), north up. */
export function overviewStop(
  points: readonly LngLat[],
  covered: number,
  animationDuration: number,
): CameraStop {
  const lngs = points.map((point) => point[0]);
  const lats = points.map((point) => point[1]);
  return {
    bounds: {
      ne: [Math.max(...lngs), Math.max(...lats)],
      sw: [Math.min(...lngs), Math.min(...lats)],
      paddingTop: OVERVIEW_TOP,
      paddingBottom: covered + OVERVIEW_BOTTOM_GAP,
      paddingLeft: OVERVIEW_SIDE,
      paddingRight: OVERVIEW_SIDE,
    },
    pitch: OVERVIEW_PITCH,
    heading: 0,
    animationDuration,
    animationMode: "easeTo",
  };
}
