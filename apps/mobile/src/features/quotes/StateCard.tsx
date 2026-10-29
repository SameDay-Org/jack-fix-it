import { Text, View } from "react-native";

import { Button, Card } from "@/components/ui";

export type StateCardProps = {
  title: string;
  body: string;
  /** The one thing to do next, when there is one. */
  action?: string;
  onAction?: () => void;
  /** The action is under way: its button shows a spinner and ignores taps. */
  busy?: boolean;
  testID: string;
};

/** A state in a bubble: what happened, and what to do next. */
export function StateCard({ title, body, action, onAction, busy, testID }: StateCardProps) {
  return (
    <Card testID={testID} className="gap-4">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {title}
        </Text>
        <Text className="text-callout text-gray-500">{body}</Text>
      </View>
      {action && onAction ? (
        <Button label={action} onPress={onAction} loading={busy} testID={`${testID}-action`} />
      ) : null}
    </Card>
  );
}
