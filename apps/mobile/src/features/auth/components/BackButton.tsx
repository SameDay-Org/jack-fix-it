import { router } from "expo-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui";

/** Back to the previous step; from a deep link with no history, back to welcome. */
export function BackButton() {
  const { t } = useTranslation();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(auth)/welcome");
  };

  // The ghost pill's own padding pulls the label back to the content edge.
  return (
    <Button
      label={t("common.back")}
      variant="ghost"
      onPress={goBack}
      className="-ml-5 self-start"
      testID="back-button"
    />
  );
}
