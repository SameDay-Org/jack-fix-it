import { router } from "expo-router";
import { useCallback, useEffect, useRef } from "react";

import type { MediaSource } from "./useMediaUpload";

// The one choice waiting for an answer from the source sheet.
let settle: ((source: MediaSource | null) => void) | null = null;

/**
 * Opens the "Camera or library" sheet with `open` (a push to the sheet's route) and resolves with
 * the source chosen there, or `null` when the sheet is dismissed. It resolves once the sheet is
 * gone, so the camera or the picker never opens over a sheet that is still closing.
 */
export function chooseMediaSource(open: () => void): Promise<MediaSource | null> {
  settle?.(null); // an older choice still waiting is abandoned
  return new Promise((resolve) => {
    settle = resolve;
    open();
  });
}

/**
 * For the sheet's route: `choose(source)` closes the sheet, and the choice reaches
 * `chooseMediaSource` when the sheet unmounts. Closing it any other way answers `null`.
 */
export function useMediaSourceChoice(): (source: MediaSource) => void {
  const chosen = useRef<MediaSource | null>(null);

  useEffect(
    () => () => {
      const resolve = settle;
      settle = null;
      resolve?.(chosen.current);
    },
    [],
  );

  return useCallback((source: MediaSource) => {
    chosen.current = source;
    router.back();
  }, []);
}
