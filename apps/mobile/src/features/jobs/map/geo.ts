/** A point as the API and GeoJSON give it: longitude, then latitude, in degrees. */
export type LngLat = readonly [lng: number, lat: number];

/** A line with the distance from its start to each of its points, in meters. */
export type MeasuredPath = {
  readonly points: readonly LngLat[];
  readonly along: readonly number[];
  readonly length: number;
};

/** The nearest point of a path to another point. */
export type PathHit = {
  readonly point: LngLat;
  /** Meters from the path's start to `point`. */
  readonly alongM: number;
  /** Meters from the point asked about to `point`. */
  readonly offM: number;
};

const EARTH_RADIUS_M = 6_371_008.8;
const DEGREES = 360;
const HALF_TURN = 180;
const toRad = (deg: number) => (deg * Math.PI) / HALF_TURN;
const toDeg = (rad: number) => (rad * HALF_TURN) / Math.PI;

/** Meters between two points (haversine). */
export function distanceM(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** An angle in degrees brought into [0, 360). */
export const normalizeDeg = (deg: number): number => ((deg % DEGREES) + DEGREES) % DEGREES;

/** The direction from `a` to `b`, in degrees clockwise from north, in [0, 360). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const [lat1, lat2] = [toRad(a[1]), toRad(b[1])];
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** The signed turn from heading `from` to heading `to` the short way round, in (-180, 180]. */
export function turnDeg(from: number, to: number): number {
  const turn = normalizeDeg(to - from);
  return turn > HALF_TURN ? turn - DEGREES : turn;
}

/**
 * `from` turned `share` of the short way toward `to`, NOT wrapped: 350 toward 10 gives 370, so an
 * animation between the two values turns 20 degrees, never 340 the long way.
 */
export const towardDeg = (from: number, to: number, share = 1): number =>
  from + turnDeg(from, to) * share;

/** A path with its running distances, measured once and sampled many times. */
export function measurePath(points: readonly LngLat[]): MeasuredPath {
  const along = [0];
  for (let index = 1; index < points.length; index += 1) {
    along.push(along[index - 1] + distanceM(points[index - 1], points[index]));
  }
  return { points, along, length: along[along.length - 1] ?? 0 };
}

const lerp = (a: LngLat, b: LngLat, share: number): LngLat => [
  a[0] + (b[0] - a[0]) * share,
  a[1] + (b[1] - a[1]) * share,
];

/** The segment index `alongM` falls in (the last one at the end). */
function segmentAt(path: MeasuredPath, alongM: number): number {
  let index = 1;
  while (index < path.points.length - 1 && path.along[index] < alongM) index += 1;
  return index;
}

/** The point `alongM` meters along the path (held at its ends) and the direction it runs there. */
export function pointAlong(path: MeasuredPath, alongM: number): { point: LngLat; bearing: number } {
  const { points, along } = path;
  if (points.length < 2) return { point: points[0], bearing: 0 };
  const at = Math.min(path.length, Math.max(0, alongM));
  const index = segmentAt(path, at);
  const [a, b] = [points[index - 1], points[index]];
  const span = along[index] - along[index - 1];
  const share = span > 0 ? (at - along[index - 1]) / span : 0;
  return { point: lerp(a, b, share), bearing: bearingDeg(a, b) };
}

/** The part of the path from `fromM` to `toM` meters along it (each held to the path). */
export function slicePath(path: MeasuredPath, fromM: number, toM: number): LngLat[] {
  const start = pointAlong(path, fromM).point;
  const end = pointAlong(path, toM).point;
  const inner = path.points.filter(
    (_, index) => path.along[index] > fromM && path.along[index] < toM,
  );
  return [start, ...inner, end];
}

/**
 * The nearest point of the path to `p`. Each segment is flattened around `p` (meters east and
 * north), which is exact enough for the few hundred meters a pro drives between two fixes.
 */
export function nearestOnPath(path: MeasuredPath, p: LngLat): PathHit | null {
  const { points, along } = path;
  if (points.length === 0) return null;
  const metersPerLng = toRad(1) * EARTH_RADIUS_M * Math.cos(toRad(p[1]));
  const metersPerLat = toRad(1) * EARTH_RADIUS_M;
  const flat = (q: LngLat) => [(q[0] - p[0]) * metersPerLng, (q[1] - p[1]) * metersPerLat];
  let best: PathHit = { point: points[0], alongM: 0, offM: distanceM(points[0], p) };
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = flat(points[index - 1]);
    const [bx, by] = flat(points[index]);
    const [dx, dy] = [bx - ax, by - ay];
    const span = dx * dx + dy * dy;
    const share = span > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / span)) : 0;
    const offM = Math.hypot(ax + dx * share, ay + dy * share);
    if (offM < best.offM) {
      const alongM = along[index - 1] + (along[index] - along[index - 1]) * share;
      best = { point: lerp(points[index - 1], points[index], share), alongM, offM };
    }
  }
  return best;
}
