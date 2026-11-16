import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, GlassSurface } from "@/components/ui";
import { backToPrevious } from "@/features/auth/components/BackButton";

// The sheet rides this far up over the hero's bottom edge, its top corners rounded.
export const SHEET_OVERLAP = 32;
const SHEET_BOTTOM = 24;

/**
 * The round way back, over the hero's top left corner: a translucent white pill over the navy
 * drawn map, a light glass one over the live map (#353), whose streets are light.
 */
export function MapBack({ onMap = false }: { onMap?: boolean }) {
  const { t } = useTranslation();
  const button = (
    <Button
      glyph="back"
      variant={onMap ? "ghost" : "hero"}
      label={t("common.back")}
      onPress={() => backToPrevious("/")}
      testID="job-back"
    />
  );
  return (
    <View className="absolute left-4 top-2">
      {onMap ? (
        <GlassSurface tone="light" shape="pill" interactive>
          {button}
        </GlassSurface>
      ) : (
        button
      )}
    </View>
  );
}

type SheetProps = {
  children: ReactNode;
  /** A dock follows the page and pads down to the home indicator itself. */
  docked?: boolean;
  testID?: string;
};

/** The white sheet over the hero's bottom edge, padded down to the home indicator. */
export function Sheet({ children, docked = false, testID }: SheetProps) {
  const { bottom } = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <View
      className="flex-grow gap-8 rounded-t-xl bg-white px-4 pt-6"
      style={{ marginTop: -SHEET_OVERLAP, paddingBottom: (docked ? 0 : bottom) + SHEET_BOTTOM }}
      testID={testID}
    >
      {/* White below the end too, so an iOS bounce past the bottom never shows the navy page.
          First, so everything in the sheet paints over it. */}
      <View
        pointerEvents="none"
        className="absolute left-0 right-0 bg-white"
        style={{ bottom: -height, height }}
        testID="job-sheet-skirt"
      />
      {children}
    </View>
  );
}
