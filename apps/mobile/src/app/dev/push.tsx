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

// Long enough to leave the app (Home, or a kill for a cold start) before the notification lands.
const DELAY_SECONDS = 8;

const LINKS: { label: string; url: (id: string) => string }[] = [
  { label: "Customer job", url: (id) => `/requests/${id}/job` },
  { label: "Request (quotes)", url: (id) => `/requests/${id}` },
  { label: "Pro job", url: (id) => `/jobs/${id}` },
  { label: "Opportunity", url: (id) => `/opportunities/${id}` },
  { label: "Quote (no screen yet)", url: (id) => `/quotes/${id}` },
  { label: "Unknown path", url: () => "/settings" },
];

export default function PushDemoScreen() {
  const [id, setId] = useState("");
  const [status, setStatus] = useState("");

  if (!__DEV__) return <Redirect href="/" />;

  const allow = async () => {
    const { status: granted } = await Notifications.requestPermissionsAsync();
    setStatus(`Permission: ${granted}`);
  };

  const post = async (label: string, url: string) => {
    await Notifications.scheduleNotificationAsync({
      content: { title: `Dev push: ${label}`, body: url, data: { url } },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: DELAY_SECONDS,
      },
    });
    setStatus(`Posts in ${DELAY_SECONDS} s: ${url}`);
  };

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
        <Input label="Id (request, job or dispatch)" value={id} onChangeText={setId} />
        <View className="gap-3">
          {LINKS.map((link) => (
            <Button
              key={link.label}
              label={link.label}
              variant="secondary"
              onPress={() => void post(link.label, link.url(id.trim()))}
            />
          ))}
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
