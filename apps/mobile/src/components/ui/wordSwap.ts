// The arithmetic behind WordRotator, kept pure so it can run as a worklet and be tested as data.
// A run is a list of word indices (`swapSequence`) and a single number, the cycle position: `step`
// whole swaps are done and `t` (0..1, already eased by the timing) is the progress of the next.

export type WordFrame = { translateY: number; opacity: number };

/**
 * The word indices a run visits: the first word, then the next `swaps - 1` words in order, then
 * `stopAt`. `swapSequence(5, 3, 0)` is `[0, 1, 2, 0]`: three swaps that settle back on the first.
 */
export function swapSequence(count: number, swaps: number, stopAt: number): number[] {
  if (count === 0) return [];
  const sequence = [0];
  for (let k = 1; k < swaps; k += 1) sequence.push(k % count);
  if (swaps > 0) sequence.push(stopAt % count);
  return sequence;
}

/** The outgoing and incoming words at cycle position `cycle`, and the eased progress between them. */
function at(
  cycle: number,
  sequence: readonly number[],
): { current: number; next: number; t: number } {
  "worklet";
  const last = sequence.length - 1;
  const step = Math.min(Math.floor(cycle), last);
  return {
    current: sequence[step],
    next: sequence[Math.min(step + 1, last)],
    t: step === last ? 0 : cycle - step,
  };
}

/**
 * Where word `index` sits for cycle position `cycle`. With `slide` the outgoing word moves up and
 * out and the incoming one rolls in from below; without it (Reduce Motion) they crossfade in place.
 */
export function wordFrame(
  cycle: number,
  index: number,
  sequence: readonly number[],
  lineHeight: number,
  slide: boolean,
): WordFrame {
  "worklet";
  if (sequence.length === 0) return { translateY: 0, opacity: index === 0 ? 1 : 0 };
  const { current, next, t } = at(cycle, sequence);
  if (index === current && (t === 0 || current === next)) return { translateY: 0, opacity: 1 };
  if (index === current) return { translateY: slide ? -t * lineHeight : 0, opacity: 1 - t };
  if (index === next) return { translateY: slide ? (1 - t) * lineHeight : 0, opacity: t };
  return { translateY: slide ? lineHeight : 0, opacity: 0 };
}

/** The clip's width for cycle position `cycle`: a tween between the outgoing and incoming words' widths. */
export function widthAt(
  cycle: number,
  sequence: readonly number[],
  widths: readonly number[],
): number {
  "worklet";
  if (sequence.length === 0 || widths.length === 0) return 0;
  const { current, next, t } = at(cycle, sequence);
  const from = widths[current];
  const to = widths[next];
  return from + (to - from) * t;
}
