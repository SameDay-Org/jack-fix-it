import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button } from "@/components/ui";

import type { FormFailure } from "../useCredentialsForm";

type FormErrorProps = {
  failure: FormFailure | null;
  /** Shown as the one helpful action when the account exists already. */
  onLoginInstead?: () => void;
  testID?: string;
};

/** What went wrong with the whole form, announced politely, with the one action that helps. */
export function FormError({ failure, onLoginInstead, testID }: FormErrorProps) {
  const { t } = useTranslation();
  if (!failure) return null;

  return (
    <View className="gap-2" testID={testID}>
      <Text
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        className="text-callout text-danger"
      >
        {failure.message}
      </Text>
      {failure.offerLogin && onLoginInstead ? (
        <Button
          label={t("auth.errors.loginInstead")}
          variant="secondary"
          onPress={onLoginInstead}
          className="self-start"
          testID={testID && `${testID}-login-instead`}
        />
      ) : null}
    </View>
  );
}
