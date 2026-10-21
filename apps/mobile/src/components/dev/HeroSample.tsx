// Dev-only sample for the gallery (src/app/dev/components.tsx); the strings are literal on purpose.
import { Text, View } from "react-native";

import { continuousCorners } from "@/theme";

/**
 * Hero after references 02a and 03: navy sheet, display headline with one lime word, a pill search
 * field. The prompt wraps instead of truncating, so on a 320 dp screen at font scale 1.3 the whole
 * prompt and the Search action stay visible and the pill grows with the text. The top safe area is
 * the Screen's; the working search ships with the home screen (#33).
 */
export function HeroSample() {
  return (
    <View className="rounded-b-xl bg-navy-900" style={continuousCorners}>
      <View className="gap-6 px-4 pb-8 pt-4">
        <View className="gap-2">
          <Text className="text-center text-display text-white">
            What needs <Text className="text-green-500">fixing</Text> today?
          </Text>
          <Text className="text-center text-callout text-white">
            Component kit sample, dev only
          </Text>
        </View>
        <View className="flex-row overflow-hidden rounded-pill bg-white">
          <View className="min-h-12 flex-1 justify-center px-4 py-3">
            <Text className="text-callout text-gray-500">Describe the job</Text>
          </View>
          <View className="min-h-12 items-center justify-center bg-green-500 px-4">
            <Text className="text-headline text-navy-900">Search</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
