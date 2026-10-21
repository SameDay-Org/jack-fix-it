// The arithmetic behind WordRotator, kept pure so it can run as a worklet and be tested as data.
// A run is a single number, the cycle position: `step` whole swaps are done and `t` (0..1, already
// eased by the timing) is the progress of the next one. Word indices wrap, so a run of
// `swapSteps(count, stopAt)` swaps shows every word once and settles on `stopAt`.

export type WordFrame = { translateY: number; opacity: number };

/** How many swaps a run makes: every word once, then on to `stopAt`. */
export function swapSteps(count: number, stopAt: number): number {
  return count + (stopAt % count);
}

/** The word shown at rest once `steps` swaps are done. */
export function wordAfter(steps: number, count: number): number {
  return steps % count;
}

/**
 * Where word `index` sits for cycle position `cycle`. With `slide` the outgoing word moves up and
 * out and the incoming one rolls in from below; without it (Reduce Motion) they crossfade in place.
 */
export function wordFrame(
  cycle: number,
  index: number,
  count: number,
  lineHeight: number,
  slide: boolean,
): WordFrame {
  "worklet";
  const step = Math.floor(cycle);
  const t = cycle - step;
  const current = step % count;
  const next = (step + 1) % count;
  if (index === current && (t === 0 || current === next)) return { translateY: 0, opacity: 1 };
  if (index === current) return { translateY: slide ? -t * lineHeight : 0, opacity: 1 - t };
  if (index === next) return { translateY: slide ? (1 - t) * lineHeight : 0, opacity: t };
  return { translateY: slide ? lineHeight : 0, opacity: 0 };
}

/** The clip's width for cycle position `cycle`: a tween between the outgoing and incoming words' widths. */
export function widthAt(cycle: number, widths: readonly number[]): number {
  "worklet";
  const count = widths.length;
  if (count === 0) return 0;
  const step = Math.floor(cycle);
  const t = cycle - step;
  const from = widths[step % count];
  const to = widths[(step + 1) % count];
  return from + (to - from) * t;
}
