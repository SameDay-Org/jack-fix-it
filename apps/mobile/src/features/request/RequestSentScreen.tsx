import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, moveAccessibilityFocus, Screen } from "@/components/ui";

import { sentRequest } from "./sent";

/**
 * "Jack is on it": the request went through. The whole navy screen, not a card: the headline,
 * the request's code to quote to support, one line on what happens next, and the way to the
 * request (its quotes, waiting until the first arrives). The flow is gone from the stack, so Back
 * goes Home. Reached with an id this session did not just send, it opens that request instead.
 */
export function RequestSentScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const request = sentRequest(id);
  const titleRef = useRef<ComponentRef<typeof Text>>(null);

  useEffect(() => {
    moveAccessibilityFocus(titleRef.current);
  }, []);

  if (!request) {
    return <Redirect href={id ? { pathname: "/requests/[id]", params: { id } } : "/"} />;
  }

  return (
    <Screen bar="hero" testID="request-sent">
      <View className="flex-1 justify-between px-6 pb-4 pt-16">
        <View className="gap-8">
          <Text ref={titleRef} accessibilityRole="header" className="text-display text-white">
            {t("request.sent.title")}
          </Text>
          <View className="gap-1">
            <Text className="text-footnote font-semibold text-white/70">
              {t("request.sent.codeLabel")}
            </Text>
            <Text selectable className="text-title-1 text-green-500" testID="request-sent-code">
              {request.public_code}
            </Text>
          </View>
          <Text className="text-body text-white">{t("request.sent.next")}</Text>
        </View>
        <View className="gap-3">
          <Button
            label={t("request.sent.see")}
            size="lg"
            onPress={() =>
              router.replace({ pathname: "/requests/[id]", params: { id: request.id } })
            }
            testID="request-sent-see"
          />
          <Button
            label={t("request.sent.home")}
            variant="hero"
            size="lg"
            onPress={() => router.dismissTo("/")}
            testID="request-sent-home"
          />
        </View>
      </View>
    </Screen>
  );
}
