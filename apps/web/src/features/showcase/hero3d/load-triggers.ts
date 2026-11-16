/**
 * When the 3D phone loads (#403 PR 2, Foreman's decision of 2026-11-16):
 *
 * - once the page has loaded and the browser is idle (`idle`), its chunk is downloaded,
 *   three.js unevaluated (scene-loader.ts);
 * - on the reader's first intent (`intent`: a scroll, the wheel, a touch, a pointer, a key),
 *   it is built: three.js evaluated, WebGL set up (downloading the chunk first if the idle
 *   moment has not come yet);
 * - neither happens while `canLoad` says no (a hidden tab, a hero that is not pinned); they
 *   catch up on `changed`, when that may have changed.
 *
 * It builds once at most; `download` must be safe to call again.
 */
export type LoadTriggers = {
  idle(): void;
  intent(): void;
  changed(): void;
};

export function loadTriggers(options: {
  canLoad: () => boolean;
  download: () => void;
  build: () => void;
}): LoadTriggers {
  let idle = false;
  let intent = false;
  let built = false;
  const advance = () => {
    if (built || !options.canLoad()) return;
    if (idle || intent) options.download();
    if (intent) {
      built = true;
      options.build();
    }
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
