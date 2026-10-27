// Dev-only: the media upload demo on a light page, as product screens will host it. Unreachable
// outside __DEV__; the sample strings are literal on purpose.
import { Redirect } from "expo-router";
import { ScrollView, Text, View } from "react-native";

import { MediaUploadSample } from "@/components/dev/MediaUploadSample";
import { Screen } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

export default function MediaDemoScreen() {
  if (!__DEV__) return <Redirect href="/" />;

  return (
    <Screen bar="light">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-8 pt-2">
        <BackButton />
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            Media upload
          </Text>
          <Text className="text-callout text-gray-500">
            Request media: pick, compress on the phone, upload to storage.
          </Text>
        </View>
        <MediaUploadSample />
      </ScrollView>
    </Screen>
  );
}
