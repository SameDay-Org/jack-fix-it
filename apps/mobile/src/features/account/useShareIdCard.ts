import * as Sharing from "expo-sharing";
import { useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { showToast, type IdCardShareHandle } from "@/components/ui";

/** Why a share could not start; never shown, the toast says it calmly. */
const UNAVAILABLE = "The share sheet is not available on this device";
const NOT_MOUNTED = "The share render is not mounted";

/**
 * Shares the ID card as a PNG (#293): the off-screen `IdCardShareRender` behind `render` draws it
 * at 3x or more, then the system share sheet takes it. One share at a time; any failure (no share
 * sheet, the photo did not load, the capture failed) ends in one calm toast. Closing the sheet
 * without picking an app is not a failure.
 */
export function useShareIdCard(render: RefObject<IdCardShareHandle | null>) {
  const { t } = useTranslation();
  const [sharing, setSharing] = useState(false);
  // State lags a render: a second tap before it lands must not open a second sheet.
  const inFlight = useRef(false);

  const share = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error(UNAVAILABLE);
      const handle = render.current;
      if (!handle) throw new Error(NOT_MOUNTED);
      const { uri } = await handle.capture();
      await Sharing.shareAsync(uri, {
        mimeType: "image/png",
        UTI: "public.png",
        dialogTitle: t("account.share.dialogTitle"),
      });
    } catch {
      showToast({ message: t("account.share.failed"), tone: "neutral" });
    } finally {
      inFlight.current = false;
      setSharing(false);
    }
  };

  return { sharing, share };
}
