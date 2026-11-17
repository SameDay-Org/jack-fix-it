/**
 * When the 3D phone loads (#403 PR 2, Foreman's decision of 2026-11-16):
 *
 * - once the page has loaded and the browser is idle (`idle`), its chunk is downloaded,
 *   three.js unevaluated (scene-loader.ts);
 * - on the reader's first intent (`intent`: a scroll, the wheel, a touch, a pointer, a key),
 *   it is built: three.js evaluated, WebGL set up (downloading the chunk first if the idle
 *   moment has not come yet);
 * - neither happens while `canLoad` says no (a hidden tab, a hero that is not pinned, Reduce
 *   Motion); they catch up on `changed`, when that may have changed.
 *
 * `build` resolves true once it is over (the phone is ready, or it failed for good) and false
 * when it paused because `canLoad` turned to no during one of its waits (build-phone.ts): the
 * intent is kept, and the build runs again as soon as it can (at once if it already can, else on
 * `changed` or the next `intent`). It never runs twice at the same time; `download` must be safe
 * to call again.
 */
export type LoadTriggers = {
  idle(): void;
  intent(): void;
  changed(): void;
};

export function loadTriggers(options: {
  canLoad: () => boolean;
  download: () => void;
  build: () => Promise<boolean>;
}): LoadTriggers {
  let idle = false;
  let intent = false;
  let state: "waiting" | "building" | "built" = "waiting";
  const advance = () => {
    if (state !== "waiting" || !options.canLoad()) return;
    if (idle || intent) options.download();
    if (!intent) return;
    state = "building";
    options.build().then(
      (finished) => {
        state = finished ? "built" : "waiting";
        if (!finished) advance();
      },
      () => {
        state = "built";
      },
    );
  };
  return {
    idle() {
      idle = true;
      advance();
    },
    intent() {
      intent = true;
      advance();
    },
    changed: advance,
  };
}
