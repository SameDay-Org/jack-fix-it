import {
  distanceM,
  measurePath,
  nearestOnPath,
  normalizeDeg,
  pointAlong,
  slicePath,
  towardDeg,
  type LngLat,
  type MeasuredPath,
} from "./geo";

/** A fix this close to the route is drawn on it: phone positions drift off the road. */
export const SNAP_M = 25;
/** A move shorter than this is position noise: the van stays put and keeps its heading. */
export const MIN_MOVE_M = 3;
/** How quickly the van turns toward a new heading: the time constant of the easing, in ms. */
export const TURN_TAU_MS = 350;
/** Points closer than this are one point: a zero-length step has no direction. */
const SAME_POINT_M = 0.1;

/** One position of the pro, as the API sent it. `at` tells a new fix from the same one again. */
export type Fix = { point: LngLat; heading: number | null; at: string };

/** Where the van is drawn and the way it points, in degrees clockwise from north. */
export type VanPose = { point: LngLat; bearing: number };

/** The van's drive from where it is drawn to the newest fix, at a constant speed. */
export type Glide = {
  path: MeasuredPath;
  startedAt: number;
  durationMs: number;
  /** The way the van points once it is there. */
  restBearing: number;
};

/** The point drawn for a position: on the route when it is within SNAP_M of it. */
function onRoute(point: LngLat, route: MeasuredPath | null) {
  const hit = route ? nearestOnPath(route, point) : null;
  return hit !== null && hit.offM <= SNAP_M ? hit : null;
}

function withoutRepeats(points: readonly LngLat[]): LngLat[] {
  return points.filter(
    (point, index) => index === 0 || distanceM(points[index - 1], point) >= SAME_POINT_M,
  );
}

/** The way along a route from `from` to `to` when both lie on it in that order; else null. */
function alongARoute(
  from: LngLat,
  to: LngLat,
  routes: readonly (MeasuredPath | null)[],
): LngLat[] | null {
  for (const route of routes) {
    const start = onRoute(from, route);
    const end = onRoute(to, route);
    if (route && start && end && end.alongM >= start.alongM) {
      return withoutRepeats([from, ...slicePath(route, start.alongM, end.alongM)]);
    }
  }
  return null;
}

/**
 * The glide to a new fix, starting where the van is drawn now (never a jump), along the route
 * (the newest one, else the one before it) when both ends lie on it, straight otherwise. The fix
 * itself is drawn on the newest route when close to it, so the van never goes past the route's end.
 * The van then points the pro's heading while moving; without one, the way it just drove (the
 * last two positions); standing still (a heading is noise then), the way the route goes on from
 * there; with none of these, the way it pointed already.
 */
export function planGlide(
  shown: VanPose | null,
  fix: Fix,
  routes: readonly (MeasuredPath | null)[],
  now: number,
  durationMs: number,
): Glide {
  const route = routes[0] ?? null;
  const hit = onRoute(fix.point, route);
  const target = hit ? hit.point : fix.point;
  const routeBearing = route && hit ? pointAlong(route, hit.alongM).bearing : null;
  if (shown === null) {
    return {
      path: measurePath([target]),
      startedAt: now,
      durationMs: 0,
      restBearing: fix.heading ?? routeBearing ?? 0,
    };
  }
  const path = measurePath(
    alongARoute(shown.point, target, routes) ?? withoutRepeats([shown.point, target]),
  );
  const moved = path.length >= MIN_MOVE_M;
  const restBearing = moved
    ? (fix.heading ?? pointAlong(path, path.length).bearing)
    : (routeBearing ?? shown.bearing);
  return { path, startedAt: now, durationMs: moved ? durationMs : 0, restBearing };
}

/** Where the glide is at `now`, and the way the van should point there. */
export function sampleGlide(
  glide: Glide,
  now: number,
): { point: LngLat; heading: number; done: boolean } {
  const elapsed = glide.durationMs > 0 ? (now - glide.startedAt) / glide.durationMs : 1;
  const share = Math.min(1, Math.max(0, elapsed));
  const { point, bearing } = pointAlong(glide.path, glide.path.length * share);
  const moving = share < 1 && glide.path.length >= MIN_MOVE_M;
  return { point, heading: moving ? bearing : glide.restBearing, done: share >= 1 };
}

/** The heading `dtMs` later, eased toward `target` the short way round, in [0, 360). */
export function smoothTurn(current: number, target: number, dtMs: number): number {
  const share = 1 - Math.exp(-Math.max(0, dtMs) / TURN_TAU_MS);
  return normalizeDeg(towardDeg(current, target, share));
}
