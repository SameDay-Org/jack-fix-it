import { Redirect } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Screen, TextSkeleton } from "@/components/ui";

import type { RequestFlowState } from "./useRequestFlow";

/**
 * A step before its category is known. `missing` goes home, where every request starts; `loading`
 * is the step's own shape (a link opened before the categories loaded); `failed` says so and
 * offers a retry. Started from home, none of these shows: the categories are cached by then.
 */
export function FlowFallback({ flow }: { flow: Exclude<RequestFlowState, { status: "ready" }> }) {
  const { t } = useTranslation();
  if (flow.status === "missing") return <Redirect href="/" />;

  return (
    <Screen bar="light" testID="request-fallback">
      {flow.status === "loading" ? (
        <View
          accessible
          accessibilityLabel={t("common.loading")}
          className="gap-4 px-4 pt-20"
          testID="request-loading"
        >
          <TextSkeleton type="title-1" width="70%" />
          <TextSkeleton type="body" width="90%" />
        </View>
      ) : (
        <View className="flex-1 justify-center gap-4 px-4" testID="request-load-failed">
          <Text accessibilityRole="header" className="text-title-2 text-navy-900">
            {t("request.loadFailed.title")}
          </Text>
          <Text className="text-body text-gray-500">{t("request.loadFailed.body")}</Text>
          <Button
            label={t("request.loadFailed.retry")}
            onPress={flow.retry}
            testID="request-retry"
          />
        </View>
      )}
    </Screen>
  );
}
