import { router, type Href } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { showToast } from "@/components/ui";

import { chooseMediaSource, closeMediaSourceSheet } from "./mediaSource";
import type { MediaUpload } from "./useMediaUpload";

/**
 * The Add button's work: asks "Camera or library" in the sheet at `sourceSheet`, then hands the
 * choice to the list's `add`. `adding` holds from the tap until the camera or the picker returns,
 * so a second tap opens nothing.
 */
export function useMediaAdd(upload: MediaUpload, sourceSheet: Href) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const addingNow = useRef(false);
  const { acceptsVideo, add: addFrom } = upload;

  const add = useCallback(async () => {
    if (addingNow.current) return;
    addingNow.current = true;
    setAdding(true);
    try {
      const source = await chooseMediaSource(() => router.push(sourceSheet), { acceptsVideo });
      if (!source) return;
      try {
        await addFrom(source);
      } finally {
        closeMediaSourceSheet();
      }
    } catch {
      showToast({ message: t("media.pickFailed"), tone: "danger" });
    } finally {
      addingNow.current = false;
      setAdding(false);
    }
  }, [acceptsVideo, addFrom, sourceSheet, t]);

  return { adding: adding || upload.picking, add };
}
