import { useTranslation } from "react-i18next";
import { Text } from "react-native";

import { Button, SheetContent } from "@/components/ui";

import { useMediaSourceChoice } from "./mediaSource";

/**
 * The "Camera or library" choice, rendered by a sheet route presented with
 * `sheetOptions("fitToContents")`. The two choices are full-width buttons in the body, so they
 * never squeeze into one row on a narrow phone or at a large font. Choosing answers the waiting
 * `chooseMediaSource`; the camera or picker opens over this sheet, and the caller closes it after.
 */
export function MediaSourceSheet() {
  const { t } = useTranslation();
  const { acceptsVideo, choose } = useMediaSourceChoice();

  return (
    <SheetContent
      title={t(acceptsVideo ? "media.source.titleMedia" : "media.source.title")}
      fitToContents
      testID="media-source-sheet"
    >
      <Text className="text-callout text-gray-500">
        {t(acceptsVideo ? "media.source.bodyMedia" : "media.source.body")}
      </Text>
      <Button
        label={t("media.source.library")}
        size="lg"
        onPress={() => choose("library")}
        testID="media-source-library"
      />
      <Button
        label={t("media.source.camera")}
        size="lg"
        variant="secondary"
        onPress={() => choose("camera")}
        testID="media-source-camera"
      />
    </SheetContent>
  );
}
