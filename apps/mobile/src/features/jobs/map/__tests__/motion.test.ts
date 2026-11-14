import {
  bearingDeg,
  distanceM,
  measurePath,
  nearestOnPath,
  pointAlong,
  slicePath,
  towardDeg,
  turnDeg,
} from "../geo";
import { MIN_MOVE_M, planGlide, sampleGlide, SNAP_M, smoothTurn, type Fix } from "../motion";

import { at, DOOR, L_ROUTE } from "./helpers";

const ROUTE = measurePath(L_ROUTE);
const fix = (point: Fix["point"], heading: number | null = null, stamp = "t1"): Fix => ({
  point,
  heading,
  at: stamp,
});

describe("headings turn the short way round", () => {
  it.each([
    [350, 10, 20],
    [10, 350, -20],
    [90, 270, 180],
    [0, 0, 0],
    [180, 179, -1],
  ])("from %s to %s turns %s degrees", (from, to, turn) => {
    expect(turnDeg(from, to)).toBe(turn);
  });

  it("unwraps the target, so an animation from 350 to it turns +20, not -340", () => {
    expect(towardDeg(350, 10)).toBe(370);
    expect(towardDeg(10, 350)).toBe(-10);
    expect(towardDeg(350, 10, 0.5)).toBe(360);
  });

  it("eases the van's heading over the short arc and keeps it in [0, 360)", () => {
    // One time constant later the van has turned 63% of the 20 degrees, clockwise through north.
    const next = smoothTurn(350, 10, 350);
    expect(turnDeg(350, next)).toBeCloseTo(20 * (1 - Math.exp(-1)), 3);
    expect(next).toBeGreaterThanOrEqual(0);
    expect(next).toBeLessThan(360);
    expect(smoothTurn(350, 10, 60_000)).toBeCloseTo(10, 3);
    expect(smoothTurn(10, 350, 60_000)).toBeCloseTo(350, 3);
  });
});

describe("paths", () => {
  it("measures and samples a route in meters", () => {
    expect(ROUTE.length).toBeCloseTo(800, 0);
    const corner = pointAlong(ROUTE, 400);
    expect(distanceM(corner.point, at(0, 400))).toBeLessThan(0.5);
    expect(pointAlong(ROUTE, 200).bearing).toBeCloseTo(0, 1);
    expect(pointAlong(ROUTE, 600).bearing).toBeCloseTo(90, 1);
    expect(pointAlong(ROUTE, 5000).point).toEqual(DOOR);
    expect(bearingDeg(at(0, 0), at(-10, 0))).toBeCloseTo(270, 1);
  });

  it("finds the nearest point on the route and how far along it is", () => {
    const hit = nearestOnPath(ROUTE, at(12, 250));
    expect(hit?.offM).toBeCloseTo(12, 0);
    expect(hit?.alongM).toBeCloseTo(250, 0);
    expect(distanceM(hit!.point, at(0, 250))).toBeLessThan(0.5);
  });

  it("cuts the part of the route between two distances, corner included", () => {
    const part = slicePath(ROUTE, 300, 500);
    expect(part).toHaveLength(3);
    expect(distanceM(part[1], at(0, 400))).toBeLessThan(0.5);
    expect(measurePath(part).length).toBeCloseTo(200, 0);
  });
});

describe("planGlide", () => {
  const NOW = 1_000;
  const SPAN = 10_000;
  const shownAt = (point: Fix["point"], bearing = 0) => ({ point, bearing });

  it("starts each glide where the van is drawn: it never jumps", () => {
    const glide = planGlide(shownAt(at(0, 100)), fix(at(0, 300)), [ROUTE], NOW, SPAN);
    expect(glide.path.points[0]).toEqual(at(0, 100));
    expect(sampleGlide(glide, NOW).point).toEqual(at(0, 100));
    expect(sampleGlide(glide, NOW + SPAN).done).toBe(true);
  });

  it("drives along the route around the corner, at a constant speed", () => {
    const glide = planGlide(shownAt(at(0, 300)), fix(at(100, 400)), [ROUTE], NOW, SPAN);
    expect(glide.path.length).toBeCloseTo(200, 0);
    const half = sampleGlide(glide, NOW + SPAN / 2);
    expect(distanceM(half.point, at(0, 400))).toBeLessThan(1);
    const quarter = sampleGlide(glide, NOW + SPAN / 4);
    expect(distanceM(quarter.point, at(0, 350))).toBeLessThan(1);
    expect(quarter.heading).toBeCloseTo(0, 0);
    expect(sampleGlide(glide, NOW + (SPAN * 3) / 4).heading).toBeCloseTo(90, 0);
  });

  it("draws a fix within SNAP_M of the route on the route", () => {
    const glide = planGlide(shownAt(at(0, 100)), fix(at(SNAP_M - 5, 200)), [ROUTE], NOW, SPAN);
    const end = sampleGlide(glide, NOW + SPAN).point;
    expect(distanceM(end, at(0, 200))).toBeLessThan(0.5);
  });

  it("leaves a fix far off the route where it is, straight from the van", () => {
    const off = at(SNAP_M + 30, 200);
    const glide = planGlide(shownAt(at(0, 100)), fix(off), [ROUTE], NOW, SPAN);
    expect(glide.path.points).toEqual([at(0, 100), off]);
  });

  it("never goes past the route's end", () => {
    const glide = planGlide(shownAt(at(300, 400)), fix(at(410, 402)), [ROUTE], NOW, SPAN);
    expect(distanceM(sampleGlide(glide, NOW + SPAN).point, DOOR)).toBeLessThan(0.5);
  });

  it("follows the route before a recomputed one while the van is still on it", () => {
    const recomputed = measurePath([at(0, 300), at(0, 400), at(400, 400)]);
    const glide = planGlide(shownAt(at(0, 100)), fix(at(0, 300)), [recomputed, ROUTE], NOW, SPAN);
    expect(glide.path.length).toBeCloseTo(200, 0);
  });

  it("points the pro's heading once there", () => {
    const glide = planGlide(shownAt(at(0, 100)), fix(at(0, 300), 15), [ROUTE], NOW, SPAN);
    expect(glide.restBearing).toBe(15);
    expect(sampleGlide(glide, NOW + SPAN).heading).toBe(15);
  });

  it("without a heading, points the way the last two positions went", () => {
    const glide = planGlide(shownAt(at(0, 0)), fix(at(100, 100)), [null], NOW, SPAN);
    expect(glide.restBearing).toBeCloseTo(45, 0);
  });

  it("standing still, ignores the heading and points the way the route goes on", () => {
    const corner = at(0, 400);
    const glide = planGlide(shownAt(corner, 0), fix(at(1, 400), 200), [ROUTE], NOW, SPAN);
    expect(glide.path.length).toBeLessThan(MIN_MOVE_M);
    expect(glide.durationMs).toBe(0);
    expect(glide.restBearing).toBeCloseTo(90, 0);
  });

  it("standing still off any route keeps the way the van pointed", () => {
    const glide = planGlide(shownAt(at(0, 0), 123), fix(at(0, 1), 200), [null], NOW, SPAN);
    expect(glide.restBearing).toBe(123);
  });

  it("puts the first fix down at once, facing its heading or the route", () => {
    expect(planGlide(null, fix(at(0, 100), 30), [ROUTE], NOW, SPAN)).toMatchObject({
      durationMs: 0,
      restBearing: 30,
    });
    expect(planGlide(null, fix(at(200, 400)), [ROUTE], NOW, SPAN).restBearing).toBeCloseTo(90, 0);
    expect(planGlide(null, fix(at(200, 400)), [null], NOW, SPAN).restBearing).toBe(0);
  });
});
