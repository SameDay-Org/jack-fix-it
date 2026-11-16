import type { LngLat } from "../geo";

// A street corner in Austin and the meters to degrees there, for routes drawn in meters.
export const ORIGIN: LngLat = [-97.74, 30.27];
const METERS_PER_LAT = 111_195;
const METERS_PER_LNG = METERS_PER_LAT * Math.cos((ORIGIN[1] * Math.PI) / 180);

/** The point `east` and `north` meters from ORIGIN. */
export const at = (east: number, north: number): LngLat => [
  ORIGIN[0] + east / METERS_PER_LNG,
  ORIGIN[1] + north / METERS_PER_LAT,
];

/** An L-shaped route: 400 m north from ORIGIN, then 400 m east to the customer's door. */
export const L_ROUTE: LngLat[] = [at(0, 0), at(0, 400), at(400, 400)];
export const DOOR = L_ROUTE[2];
