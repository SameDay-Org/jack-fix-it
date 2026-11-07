// Dev-only: posts a local notification carrying a push's `data.url`, so a tap goes through the
// same response path a remote push does (#323), cold or warm. Unreachable outside __DEV__; the
// strings are literal on purpose. Remote pushes need the token registration (#334) and the
// FCM / APNs credentials (#335).
import * as Notifications from "expo-notifications";
import { Redirect } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Button, Input, Screen } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { isUuid } from "@/features/quotes/navigation";

// Long enough to leave the app (Home, or a kill for a cold start) before the notification lands.
const DELAY_SECONDS = 8;

// The links that carry an id take a UUID only (PR #337, Vault round 1): nothing typed here but an
// id reaches a notification.
const LINKS: { label: string; url: (id: string) => string; needsId: boolean }[] = [
  { label: "Customer job", url: (id) => `/requests/${id}/job`, needsId: true },
  { label: "Request (quotes)", url: (id) => `/requests/${id}`, needsId: true },
  { label: "Pro job", url: (id) => `/jobs/${id}`, needsId: true },
  { label: "Opportunity", url: (id) => `/opportunities/${id}`, needsId: true },
  { label: "Quote (no screen yet)", url: (id) => `/quotes/${id}`, needsId: true },
  { label: "Unknown path", url: () => "/settings", needsId: false },
];

// Synthetic markers for the logcat check (PR #337): a notification whose title, body and data
// carry them must leave none in `adb logcat`. Never real data.
const SENTINEL = {
  title: "SENTINEL-TITLE-337 sentinel.person@example.invalid",
  body: "SENTINEL-BODY-337 +1 555 0100 337",
  data: { url: "/settings", probe: "SENTINEL-DATA-337" },
};

export default function PushDemoScreen() {
  const [id, setId] = useState("");
  const [status, setStatus] = useState("");

  if (!__DEV__) return <Redirect href="/" />;

  const allow = async () => {
    const { status: granted } = await Notifications.requestPermissionsAsync();
    setStatus(`Permission: ${granted}`);
  };

  const trimmed = id.trim();
  const validId = isUuid(trimmed);

  const schedule = async (content: Notifications.NotificationContentInput, url: string) => {
    await Notifications.scheduleNotificationAsync({
      content,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: DELAY_SECONDS,
      },
    });
    setStatus(`Posts in ${DELAY_SECONDS} s: ${url}`);
  };
  const post = (label: string, url: string) =>
    schedule({ title: `Dev push: ${label}`, body: url, data: { url } }, url);

  return (
    <Screen bar="light">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-8 pt-2">
        <BackButton />
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            Push taps
          </Text>
          <Text className="text-callout text-gray-500">
            A local notification with a push&apos;s data.url. Leave the app, then tap it.
          </Text>
        </View>
        <Button label="Allow notifications" variant="secondary" onPress={() => void allow()} />
        <Input
          label="Id (request, job or dispatch)"
          value={id}
          onChangeText={setId}
          error={trimmed !== "" && !validId ? "A UUID only" : undefined}
        />
        <View className="gap-3">
          {LINKS.map((link) => (
            <Button
              key={link.label}
              label={link.label}
              variant="secondary"
              disabled={link.needsId && !validId}
              onPress={() => void post(link.label, link.url(trimmed))}
            />
          ))}
          <Button
            label="Log check (synthetic sentinels)"
            variant="secondary"
            onPress={() => void schedule(SENTINEL, SENTINEL.data.url)}
          />
        </View>
        {status ? (
          <Text className="text-callout text-navy-900" testID="push-demo-status">
            {status}
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
