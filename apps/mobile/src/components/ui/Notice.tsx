import type { ReactNode } from "react";
import { Text, View } from "react-native";

import { continuousCorners } from "@/theme";

import { cx } from "./cx";

export type NoticeProps = {
  /** `danger`: something stopped the customer; `info`: something to know before going on. */
  tone: "danger" | "info";
  title: string;
  body?: string;
  /** An action that resolves it (a retry), under the text. */
  children?: ReactNode;
  className?: string;
  testID?: string;
};

const TONE = {
  danger: { surface: "bg-danger/10", title: "text-danger" },
  info: { surface: "bg-navy-900/5", title: "text-navy-900" },
} as const;

/**
 * A message inside a page, in a soft tinted bubble: what happened in one bold line, what to do
 * next under it, and the action that fixes it when there is one. Read as an alert.
 */
export function Notice({ tone, title, body, children, className, testID }: NoticeProps) {
  return (
    <View
      accessibilityRole="alert"
      style={continuousCorners}
      className={cx("gap-1 rounded-lg p-4", TONE[tone].surface, className)}
      testID={testID}
    >
      <Text className={cx("text-headline", TONE[tone].title)}>{title}</Text>
      {body ? <Text className="text-callout text-navy-900">{body}</Text> : null}
      {children ? <View className="mt-2 flex-row">{children}</View> : null}
    </View>
  );
}
