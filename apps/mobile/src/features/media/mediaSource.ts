import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import type { MediaSource } from "./useMediaUpload";

type PendingChoice = {
  settle: (source: MediaSource | null) => void;
  /** Whether the library offers videos too, for the sheet's copy. */
  acceptsVideo: boolean;
};

// The one choice waiting for an answer from the source sheet, and whether that sheet is up.
let pending: PendingChoice | null = null;
let sheetMounted = false;

/**
 * Opens the "Camera or library" sheet with `open` (a push to the sheet's route) and resolves with
 * the source chosen there, or `null` when the sheet is closed without a choice. The sheet stays up
 * while the camera or the picker opens over it, and the caller closes it with
 * `closeMediaSourceSheet` once that returns: presenting over a sheet that is still closing fails
 * on iOS.
 */
export function chooseMediaSource(
  open: () => void,
  { acceptsVideo }: { acceptsVideo: boolean },
): Promise<MediaSource | null> {
  pending?.settle(null); // an older choice still waiting is abandoned
  return new Promise((resolve) => {
    pending = { settle: resolve, acceptsVideo };
    open();
  });
}

/** Closes the source sheet if it is still up (the user may have swiped it away). */
export function closeMediaSourceSheet(): void {
  if (sheetMounted) router.back();
}

/** For the sheet's route: what to offer, and `choose(source)`, which answers the waiting choice. */
export function useMediaSourceChoice(): {
  acceptsVideo: boolean;
  choose: (source: MediaSource) => void;
} {
  const [acceptsVideo] = useState(() => pending?.acceptsVideo ?? false);

  useEffect(() => {
    sheetMounted = true;
    return () => {
      sheetMounted = false;
      // Closed without a choice (swiped away, back): the caller gets null.
      const unanswered = pending;
      pending = null;
      unanswered?.settle(null);
    };
  }, []);

  const choose = useCallback((source: MediaSource) => {
    const waiting = pending;
    pending = null;
    waiting?.settle(source);
  }, []);

  return { acceptsVideo, choose };
}
