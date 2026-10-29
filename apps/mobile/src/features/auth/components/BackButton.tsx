import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui";

/** Back to the previous step; from a deep link with no history, to `fallback` (welcome by default). */
export function backToPrevious(fallback: Href = "/(auth)/welcome") {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

type BackButtonProps = {
  /** Runs first and receives the navigation to perform when it is done (an exit animation). */
  beforeBack?: (then: () => void) => void;
  /** Where to go with no history behind the screen; a signed-in screen passes its home. */
  fallbackHref?: Href;
};

export function BackButton({ beforeBack, fallbackHref }: BackButtonProps) {
  const { t } = useTranslation();
  const back = () => backToPrevious(fallbackHref);
  const goBack = () => (beforeBack ? beforeBack(back) : back());

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
