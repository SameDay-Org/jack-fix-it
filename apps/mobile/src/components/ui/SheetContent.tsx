import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { tokens } from "@/theme";

import { cx } from "./cx";
import { useLiquidGlass } from "./GlassSurface";

export type SheetContentProps = {
  title?: string;
  children: ReactNode;
  /** Buttons for the actions row, right-aligned, always in view. */
  actions?: ReactNode;
  /**
   * Pair with `sheetOptions("fitToContents")`: the sheet is as tall as this content, so the
   * scaffold sizes itself from the content instead of filling the sheet, and the body is capped
   * at `sheet.fitBodyMaxFraction` of the window so a long body scrolls and the actions stay in
   * view. Android shows only the dimmed backdrop when a fit-to-contents sheet gets a filling
   * (`flex: 1`) root.
   */
  fitToContents?: boolean;
  testID?: string;
};

/**
 * The body of a form sheet on the 4-pt grid: optional title, a body that scrolls when the detent
 * is shorter than the content, and an actions row that stays in view. It respects the bottom safe
 * area and keeps inputs above the keyboard. Where the system draws Liquid Glass the surface stays
 * transparent; everywhere else it is the white sheet surface (the route's `sheetCornerRadius`
 * rounds it). With fraction detents the scaffold fills the sheet; with `fitToContents` it takes
 * the content's height.
 */
export function SheetContent({
  title,
  children,
  actions,
  fitToContents = false,
  testID,
}: SheetContentProps) {
  const { bottom } = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const glass = useLiquidGlass();
  const bodyStyle = fitToContents
    ? { maxHeight: windowHeight * tokens.sheet.fitBodyMaxFraction }
    : undefined;

  return (
    // iOS needs the padding; Android resizes the window for the keyboard on its own.
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      testID={testID}
      className={cx(fitToContents ? "shrink" : "flex-1", !glass && "bg-white")}
    >
      <View
        className="shrink"
        style={{ paddingBottom: bottom }}
        testID={testID && `${testID}-inset`}
      >
        <View className="shrink gap-4 px-4 pb-4 pt-6">
          {title ? <Text className="text-title-2 text-navy-900">{title}</Text> : null}
          <ScrollView
            className="shrink"
            style={bodyStyle}
            contentContainerClassName="gap-3"
            keyboardShouldPersistTaps="handled"
            bounces={false}
          >
            {children}
          </ScrollView>
          {actions ? <View className="flex-row justify-end gap-2 pt-2">{actions}</View> : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
