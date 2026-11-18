/**
 * The frame-time probe (#403 PR 2): does this device draw the 3D phone fast enough for smooth
 * motion? It draws `frames` frames and compares the median gap between them with
 * `maxMedianMs`. Only frames the reader could see count: a hidden tab gets no frames (or a
 * few, throttled), and that says nothing about the device. So the probe waits while the page
 * is hidden, starts over when it shows again, and runs its timeout on visible time only. A gap
 * longer than `pauseMs` is a pause (a tab switch, a debugger), not a slow frame, and is left out.
 */

export const PROBE = { frames: 24, maxMedianMs: 45, timeoutMs: 4000, pauseMs: 250 } as const;

export type ProbeOptions = typeof PROBE;

/** What the probe needs from the browser, so tests can drive it. */
export type ProbeHost = {
  requestFrame(callback: (now: number) => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(handle: number): void;
  isHidden(): boolean;
  /** Calls `listener` on every visibility change; returns the remover. */
  onVisibilityChange(listener: () => void): () => void;
};

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function browserProbeHost(win: Window): ProbeHost {
  return {
    requestFrame: (callback) => win.requestAnimationFrame(callback),
    cancelFrame: (handle) => win.cancelAnimationFrame(handle),
    setTimer: (callback, ms) => win.setTimeout(callback, ms),
    clearTimer: (handle) => win.clearTimeout(handle),
    isHidden: () => win.document.visibilityState === "hidden",
    onVisibilityChange: (listener) => {
      win.document.addEventListener("visibilitychange", listener);
      return () => win.document.removeEventListener("visibilitychange", listener);
    },
  };
}

/**
 * Resolves true when the frames come fast enough, false when they come too slowly or not
 * within `timeoutMs` of visible time, or when `stillValid()` turns false (the scene was
 * disposed or lost its GPU context). `draw` is called on every probed frame.
 */
export function probeFrames(
  host: ProbeHost,
  draw: (now: number) => void,
  stillValid: () => boolean,
  options: ProbeOptions = PROBE,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let gaps: number[] = [];
    let previous = 0;
    let frame = 0;
    let timer = 0;
    let settled = false;

    const stop = () => {
      if (frame) host.cancelFrame(frame);
      if (timer) host.clearTimer(timer);
      frame = 0;
      timer = 0;
    };
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      stop();
      removeListener();
      resolve(result);
    };
    const step = (now: number) => {
      frame = 0;
      if (!stillValid()) {
        finish(false);
        return;
      }
      draw(now);
      if (previous && now - previous <= options.pauseMs) gaps.push(now - previous);
      previous = now;
      if (gaps.length >= options.frames) {
        finish(stillValid() && median(gaps) <= options.maxMedianMs);
        return;
      }
      frame = host.requestFrame(step);
    };
    const start = () => {
      stop();
      gaps = [];
      previous = 0;
      if (host.isHidden()) return; // waits for the page to show
      timer = host.setTimer(() => finish(false), options.timeoutMs);
      frame = host.requestFrame(step);
    };
    const removeListener = host.onVisibilityChange(() => {
      if (!settled) start();
    });
    start();
  });
}
