import * as Sharing from "expo-sharing";
import { useEffect, useRef, useState, type RefObject } from "react";

import { isCurrentGeneration, sessionGeneration } from "@/api";

import { showToast, type ShareCapture, type ShareHandle } from "@/components/ui";

/** The words of a share: the share sheet's title and the calm toast after a failure. */
export type ShareImageTexts = { dialogTitle: string; failed: string };

/** Why a share could not start; never shown, the toast says it calmly. */
const UNAVAILABLE = "The share sheet is not available on this device";
const NOT_MOUNTED = "The share render is not mounted";

/**
 * Shares an off-screen render as a PNG (#293 the ID card, #62 the receipt): the render behind
 * `render` (`IdCardShareRender`, `ShareRender`) draws it at 3x or more, then the system share
 * sheet takes it. One share at a time; any failure (no share
 * sheet, the photo did not load, the capture failed) ends in one calm toast. Closing the sheet
 * without picking an app is not a failure.
 *
 * A share belongs to the signed-in screen that started it: once that session ends (log out, an
 * expired session, another account) or the screen goes away, whatever is still pending ends
 * silently. The sheet never opens with the previous account's card, and no toast outlives it.
 *
 * The PNG lives in the app's private cache only while it is needed: it is deleted once the sheet
 * closes (shared or not), and at once when the share ends any other way (failed, too late, the
 * screen gone).
 */
export function useShareImage(render: RefObject<ShareHandle | null>, texts: ShareImageTexts) {
  const [sharing, setSharing] = useState(false);
  // State lags a render: a second tap before it lands must not open a second sheet.
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const share = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSharing(true);
    const startedIn = sessionGeneration();
    const stillOurs = () => mounted.current && isCurrentGeneration(startedIn);
    let capture: ShareCapture | undefined;
    try {
      const available = await Sharing.isAvailableAsync();
      if (!stillOurs()) return;
      if (!available) throw new Error(UNAVAILABLE);
      const handle = render.current;
      if (!handle) throw new Error(NOT_MOUNTED);
      capture = await handle.capture();
      // The last check before the image leaves the app: the capture can finish after logout.
      if (!stillOurs()) return;
      await Sharing.shareAsync(capture.uri, {
        mimeType: "image/png",
        UTI: "public.png",
        dialogTitle: texts.dialogTitle,
      });
    } catch {
      if (stillOurs()) showToast({ message: texts.failed, tone: "neutral" });
    } finally {
      capture?.discard();
      inFlight.current = false;
      if (mounted.current) setSharing(false);
    }
  };

  return { sharing, share };
}
