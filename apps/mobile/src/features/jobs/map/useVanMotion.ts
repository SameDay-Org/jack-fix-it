import { useEffect, useEffectEvent, useRef } from "react";

import { turnDeg, type MeasuredPath } from "./geo";
import { planGlide, sampleGlide, smoothTurn, type Fix, type Glide, type VanPose } from "./motion";

/** The van's turn counts as finished within this many degrees of its target. */
const SETTLED_DEG = 0.5;

export type VanFrame = { pose: VanPose; glide: Glide; now: number };

type Live = { glide: Glide | null; pose: VanPose | null; last: number };

/**
 * Drives the van between fixes off React's render path: each new fix (`fix.at`) starts a glide
 * from where the van is drawn, and every animation frame until it ends and the van has turned
 * hands `onFrame` the pose to draw (the caller writes it to the map's native source). Under
 * Reduce Motion the glide lasts what `durationMs` says and the van turns at once.
 */
export function useVanMotion(
  fix: Fix,
  routes: readonly (MeasuredPath | null)[],
  durationMs: number,
  reduceMotion: boolean,
  onFrame: (frame: VanFrame) => void,
): void {
  const live = useRef<Live>({ glide: null, pose: null, last: 0 });

  const retarget = useEffectEvent((at: string, now: number) => {
    const state = live.current;
    state.glide = planGlide(state.pose, { ...fix, at }, routes, now, durationMs);
    state.pose ??= { point: state.glide.path.points[0], bearing: state.glide.restBearing };
    state.last = now;
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
    onFrame({ pose: state.pose, glide: state.glide, now });
    return !sample.done || Math.abs(turnDeg(bearing, sample.heading)) > SETTLED_DEG;
  });

  useEffect(() => {
    retarget(fix.at, Date.now());
    let frame: number | null = null;
    const loop = () => {
      frame = step(Date.now()) ? requestAnimationFrame(loop) : null;
    };
    loop();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [fix.at]);
}
