import { useEffect, useEffectEvent, useRef } from "react";

import { turnDeg, type MeasuredPath } from "./geo";
import {
  onRoute,
  planGlide,
  sampleGlide,
  smoothTurn,
  type Fix,
  type Glide,
  type VanPose,
} from "./motion";

/** The van's turn counts as finished within this many degrees of its target. */
const SETTLED_DEG = 0.5;
/** A glide planned again for a route that came in the middle of it lasts at least this long. */
const RESNAP_MIN_MS = 1000;

/** One drawn frame; `arrived` once the van stands where its glide ends (it may still turn). */
export type VanFrame = { pose: VanPose; glide: Glide; now: number; arrived: boolean };

type Live = {
  glide: Glide | null;
  pose: VanPose | null;
  last: number;
  /** The fix and the newest route the glide was planned for. */
  at: string | null;
  route: MeasuredPath | null;
  /** The frames stopped while a van was drawn: the next ones start a glide from where it is. */
  paused: boolean;
};

/**
 * Drives the van off React's render path. A glide starts from where the van is drawn (never a
 * jump) for each new fix (`fix.at`), for a newest route the same fix lies on (one that came after
 * the position, was computed again, or is back after none: the van moves onto it), and when
 * `active` comes back. Every animation frame until the glide ends and the van has turned hands
 * `onFrame` the pose to draw (the caller writes it to the map's native sources). While `active`
 * is false (the screen is not focused, the app is in the background, the job moved on) no frame
 * runs: only a van never drawn yet is placed, once. Under Reduce Motion the glide lasts what
 * `durationMs` says and the van turns at once.
 */
export function useVanMotion(
  fix: Fix,
  routes: readonly (MeasuredPath | null)[],
  durationMs: number,
  reduceMotion: boolean,
  active: boolean,
  onFrame: (frame: VanFrame) => void,
): void {
  const live = useRef<Live>({
    glide: null,
    pose: null,
    last: 0,
    at: null,
    route: null,
    paused: false,
  });
  const route = routes[0] ?? null;

  // Plans the next glide when there is a reason to; any other run keeps the one under way.
  const plan = useEffectEvent((at: string, newest: MeasuredPath | null, now: number) => {
    const state = live.current;
    const moved = state.at !== at;
    const routed = newest !== null && newest !== state.route && onRoute(fix.point, newest) !== null;
    if (newest !== null) state.route = newest;
    if (state.glide !== null && !moved && !routed && !state.paused) return;
    // A route alone leaves the van due where it was due, not a whole glide later.
    const left = state.glide ? state.glide.startedAt + state.glide.durationMs - now : 0;
    const duration =
      moved || state.paused || left <= 0
        ? durationMs
        : Math.max(left, Math.min(durationMs, RESNAP_MIN_MS));
    state.glide = planGlide(state.pose, { ...fix, at }, routes, now, duration);
    state.pose ??= { point: state.glide.path.points[0], bearing: state.glide.restBearing };
    state.last = now;
    state.at = at;
    state.paused = false;
  });

  // One frame: the van moved and turned on; true while the glide or the turn goes on.
  const step = useEffectEvent((now: number): boolean => {
    const state = live.current;
    if (state.glide === null || state.pose === null) return false;
    const sample = sampleGlide(state.glide, now);
    const bearing = reduceMotion
      ? sample.heading
      : smoothTurn(state.pose.bearing, sample.heading, now - state.last);
    state.pose = { point: sample.point, bearing };
    state.last = now;
    onFrame({ pose: state.pose, glide: state.glide, now, arrived: sample.done });
    return !sample.done || Math.abs(turnDeg(bearing, sample.heading)) > SETTLED_DEG;
  });

  useEffect(() => {
    const state = live.current;
    if (!active) {
      if (state.pose === null) {
        plan(fix.at, route, Date.now());
        step(Date.now());
      } else {
        state.paused = true;
      }
      return;
    }
    plan(fix.at, route, Date.now());
    let frame: number | null = null;
    const loop = () => {
      frame = step(Date.now()) ? requestAnimationFrame(loop) : null;
    };
    loop();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [active, fix.at, route]);
}
