/**
 * Which hero a visitor gets (#403 PR 2):
 *
 * - `static`: the phone drawn in CSS, no pinning. For a visitor who asks for reduced motion
 *   (CSS gives the same layout before any script runs, and when none runs).
 * - `css`: the pinned hero with the phone drawn in CSS; its screen and the headline change
 *   with plain CSS transitions. For a low-end device, a slow connection or data saving, and
 *   as the fallback whenever the 3D phone fails: no WebGL 2, or only a slow software one (the
 *   renderer refuses it when the phone is built), its code or a screen does not load, its
 *   frames are too slow, the GPU drops the context.
 * - `webgl`: the pinned hero, with the 3D phone built on the reader's first intent.
 *
 * Choosing makes no WebGL context: making one is expensive (it blocked the page's start by
 * hundreds of milliseconds on a throttled phone profile), so WebGL is tried only once, by the
 * 3D phone itself, when the reader shows intent.
 */
export type HeroMode = "static" | "css" | "webgl";

/** What the browser tells about itself; `null` where it does not say. */
export type HeroEnv = {
  reducedMotion: boolean;
  /** navigator.hardwareConcurrency */
  cores: number | null;
  /** navigator.deviceMemory, in GB (Chromium only). */
  memoryGb: number | null;
  /** navigator.connection.saveData (Chromium only). */
  saveData: boolean;
  /** navigator.connection.effectiveType (Chromium only). */
  effectiveType: string | null;
  /** A touch screen is the main pointer: a phone or a tablet. */
  coarsePointer: boolean;
};

/**
 * Low-end, by what Chromium reports: less than 4 GB of memory, or less than 4 cores on a
 * device that reports its memory. Safari reports no memory and caps its core count, so there
 * the frame-time probe (frame-probe.ts) is what decides.
 */
export const LOW_END = { minMemoryGb: 4, minCores: 4 } as const;

/**
 * When the hero is not pinned: reduced motion, or a viewport too short for the pinned stage
 * (a phone held sideways). The same query as the `still` variant of globals.css, which also
 * covers "no script runs".
 */
export const STILL_QUERY = "(prefers-reduced-motion: reduce), (max-height: 30rem)";

/** Connections too slow for the 3D phone's download. */
export const SLOW_CONNECTIONS: ReadonlySet<string> = new Set(["slow-2g", "2g", "3g"]);

/** The canvas's highest pixel ratio: 1.5 on phones and tablets (the spec's cap), else 2. */
export const MAX_PIXEL_RATIO = { coarse: 1.5, fine: 2 } as const;

export function isLowEnd(env: Pick<HeroEnv, "cores" | "memoryGb">): boolean {
  if (env.memoryGb === null) return false;
  return env.memoryGb < LOW_END.minMemoryGb || (env.cores !== null && env.cores < LOW_END.minCores);
}

export function chooseHeroMode(env: HeroEnv): HeroMode {
  if (env.reducedMotion) return "static";
  if (isLowEnd(env)) return "css";
  if (env.saveData || (env.effectiveType !== null && SLOW_CONNECTIONS.has(env.effectiveType))) {
    return "css";
  }
  return "webgl";
}

export function maxPixelRatio(env: Pick<HeroEnv, "coarsePointer">): number {
  return env.coarsePointer ? MAX_PIXEL_RATIO.coarse : MAX_PIXEL_RATIO.fine;
}

type NetworkInformationLike = { saveData?: boolean; effectiveType?: string };
type NavigatorLike = {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  connection?: NetworkInformationLike;
};

/** The browser side of `HeroEnv`, kept narrow so tests can pass a fake window. */
export type BrowserLike = {
  navigator: NavigatorLike;
  matchMedia(query: string): { matches: boolean };
};

function positive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function readHeroEnv(win: BrowserLike): HeroEnv {
  const nav = win.navigator;
  return {
    reducedMotion: win.matchMedia("(prefers-reduced-motion: reduce)").matches,
    cores: positive(nav.hardwareConcurrency),
    memoryGb: positive(nav.deviceMemory),
    saveData: nav.connection?.saveData === true,
    effectiveType: nav.connection?.effectiveType ?? null,
    coarsePointer: win.matchMedia("(pointer: coarse)").matches,
  };
}
