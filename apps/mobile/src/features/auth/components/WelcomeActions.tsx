import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui";
import { continuousCorners } from "@/theme";

type WelcomeActionsProps = {
  /** A sign-out could not clear the device: say so above the actions. */
  cleanupPending: boolean;
  onGetStarted: () => void;
  onLogin: () => void;
  /**
   * Takes its space but shows nothing and takes no taps or focus: the launch intro reserves the
   * area so its hero sits exactly where Welcome's does.
   */
  hidden?: boolean;
  testID?: string;
};

/**
 * Welcome's white bubble with the two ways in. It pads the bottom inset itself, so the screen
 * above it pads no edge.
 */
export function WelcomeActions({
  cleanupPending,
  onGetStarted,
  onLogin,
  hidden = false,
  testID,
}: WelcomeActionsProps) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();

  return (
    <View
      className="rounded-t-xl bg-white"
      style={[continuousCorners, { paddingBottom: bottom }, hidden && { opacity: 0 }]}
      pointerEvents={hidden ? "none" : "auto"}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={hidden}
      testID={testID}
    >
      <View className="gap-3 px-4 pb-4 pt-6">
        {cleanupPending ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion={hidden ? "none" : "polite"}
            className="text-callout text-gray-500"
            testID={testID && `${testID}-partial-cleanup`}
          >
            {t("welcome.partialCleanup")}
          </Text>
        ) : null}
        <Button
          label={t("welcome.getStarted")}
          size="lg"
          onPress={onGetStarted}
          testID={testID && `${testID}-get-started`}
        />
        <Button
          label={t("welcome.haveAccount")}
          variant="ghost"
          onPress={onLogin}
          testID={testID && `${testID}-login`}
        />
      </View>
    </View>
  );
}
