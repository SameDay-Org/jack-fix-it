import { Text, View } from "react-native";

import { Button } from "@/components/ui";

type HistoryErrorProps = {
  title: string;
  body: string;
  retry: string;
  onRetry: () => void;
  busy: boolean;
  testID: string;
};

/** Nothing to show and the first page failed: the whole screen says so, with the one way out. */
export function HistoryError({ title, body, retry, onRetry, busy, testID }: HistoryErrorProps) {
  return (
    <View className="flex-1 items-center justify-center gap-6 px-4 pb-12" testID={testID}>
      <View className="items-center gap-2">
        <Text accessibilityRole="header" className="text-center text-title-2 text-navy-900">
          {title}
        </Text>
        <Text className="text-center text-body text-gray-500">{body}</Text>
      </View>
      <Button label={retry} onPress={onRetry} loading={busy} testID={`${testID}-action`} />
    </View>
  );
}
