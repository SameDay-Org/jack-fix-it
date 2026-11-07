import * as Sharing from "expo-sharing";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { isCurrentGeneration, sessionGeneration } from "@/api";
import { showToast, type IdCardShareCapture, type IdCardShareHandle } from "@/components/ui";

/** Why a share could not start; never shown, the toast says it calmly. */
const UNAVAILABLE = "The share sheet is not available on this device";
const NOT_MOUNTED = "The share render is not mounted";

/**
 * Shares the ID card as a PNG (#293): the off-screen `IdCardShareRender` behind `render` draws it
 * at 3x or more, then the system share sheet takes it. One share at a time; any failure (no share
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
export function useShareIdCard(render: RefObject<IdCardShareHandle | null>) {
  const { t } = useTranslation();
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
    let capture: IdCardShareCapture | undefined;
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
        dialogTitle: t("account.share.dialogTitle"),
      });
    } catch {
      if (stillOurs()) showToast({ message: t("account.share.failed"), tone: "neutral" });
    } finally {
      capture?.discard();
      inFlight.current = false;
      if (mounted.current) setSharing(false);
    }
  };

  return { sharing, share };
}
