import { Text, View } from "react-native";

import { Button } from "@/components/ui";

export type RetryNoticeProps = {
  /** What did not load, in one line. */
  message: string;
  /** The retry's label. */
  action: string;
  onRetry: () => void;
  /** The retry is under way: its button shows a spinner and ignores taps. */
  busy?: boolean;
  testID: string;
};

/**
 * A quiet notice in the flow of a screen: what did not load, and the one thing to do about it.
 * Lighter than a `StateCard` because it sits among content that is still there (the cards above
 * it, the request's text beside it), aligned to their edge. Android reads the message aloud
 * when it appears (a live region); iOS has no such attribute here.
 */
export function RetryNotice({ message, action, onRetry, busy = false, testID }: RetryNoticeProps) {
  return (
    <View className="gap-3" testID={testID}>
      <Text
        accessibilityLiveRegion="polite"
        className="text-callout text-navy-900"
        testID={`${testID}-message`}
      >
        {message}
      </Text>
      <Button
        variant="secondary"
        label={action}
        onPress={onRetry}
        loading={busy}
        className="self-start"
        testID={`${testID}-action`}
      />
    </View>
  );
}
