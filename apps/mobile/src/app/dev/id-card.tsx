// Dev-only: the ID card lab. One card, alive, set by the link's params so an emulator script can
// show every variant without typing: jackfixit://dev/id-card?variant=pro&photo=sample&name=...
// `share=1` shows the flat share render instead. Unreachable outside __DEV__; strings are literal.
import { Redirect, useLocalSearchParams } from "expo-router";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";

import { SAMPLE_PHOTO } from "@/components/dev/IdCardSample";
import { IdCard, Screen, type IdCardVariant } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

const GUTTER = 16;

type LabParams = {
  variant?: string;
  /** "sample" for the gallery's photo, a file URI for a pushed portrait, absent for none. */
  photo?: string;
  name?: string;
  city?: string;
  state?: string;
  phone?: string;
  code?: string;
  /** "1": the verified seal (as for a pro the API approved). */
  verified?: string;
  since?: string;
  share?: string;
};

export default function IdCardLabScreen() {
  const params = useLocalSearchParams<LabParams>();
  const { width } = useWindowDimensions();
  if (!__DEV__) return <Redirect href="/" />;

  const variant: IdCardVariant = params.variant === "pro" ? "pro" : "customer";
  const photoUri = params.photo === "sample" ? SAMPLE_PHOTO : params.photo || undefined;
  const shareable = params.share === "1";

  return (
    <Screen bar="light">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-8 pt-2">
        <BackButton />
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          ID card lab
        </Text>
        <View className="items-center py-6">
          <IdCard
            // A new link starts a new card: front up, at rest.
            key={JSON.stringify(params)}
            variant={variant}
            width={width - GUTTER * 2}
            name={params.name ?? "Alex Morgan"}
            city={params.city ?? "Fort Lauderdale"}
            state={params.state ?? "FL"}
            phone={params.phone}
            photoUri={photoUri}
            publicCode={params.code ?? "K7Q29MXA"}
            verified={params.verified === "1"}
            memberSince={params.since}
            shareable={shareable}
            testID="lab-card"
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
