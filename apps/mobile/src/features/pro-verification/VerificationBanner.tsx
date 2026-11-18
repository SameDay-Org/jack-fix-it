import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Card, StatusBadge } from "@/components/ui";
import type { ProProfile } from "@/features/pro-profile";
import { useGuardedPush } from "@/features/quotes/navigation";

import { STATUS_TONE } from "./verification";

// Shown to sighted users only: the card's label already says it all.
const VISUAL_ONLY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/** The status screen (`/pro/verification`). */
export const VERIFICATION_HREF = "/pro/verification";

/**
 * Where the review of the pro stands, on the pro's home (#38): "Verification" beside the status
 * as a pill, and one line on what it means. It opens the status screen.
 */
export function VerificationBanner({
  profile,
  testID = "verification-banner",
}: {
  profile: ProProfile;
  testID?: string;
}) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const status = profile.verification_status;
  const label = t(`proVerification.status.${status}`);
  const line = t(`proVerification.banner.${status}`);

  return (
    <Card
      onPress={() => push(VERIFICATION_HREF)}
      accessibilityLabel={`${t("proVerification.banner.label", { status: label })}. ${line}`}
      testID={testID}
    >
      <View {...VISUAL_ONLY} className="gap-2">
        <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <Text className="shrink text-headline text-navy-900">{t("proVerification.title")}</Text>
          <StatusBadge label={label} tone={STATUS_TONE[status]} testID={`${testID}-status`} />
        </View>
        <Text className="text-callout text-gray-500">{line}</Text>
      </View>
    </Card>
  );
}
