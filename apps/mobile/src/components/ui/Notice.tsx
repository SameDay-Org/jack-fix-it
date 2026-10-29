import { useEffect, type ReactNode } from "react";
import { Text, View } from "react-native";

import { continuousCorners } from "@/theme";

import { cx } from "./cx";
import { announce } from "./focus";

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

// Navy text on both tints: danger text over its own 10% tint is under 4.5:1 (about 4.1:1 on
// white, 4.0:1 on gray-50), so the tint carries the tone. tokens.test.ts holds every pair at AA.
export const TONE = {
  danger: { surface: "bg-danger/10", title: "text-navy-900", body: "text-navy-900" },
  info: { surface: "bg-navy-900/5", title: "text-navy-900", body: "text-navy-900" },
} as const;

/**
 * A message inside a page, in a soft tinted bubble: what happened in one bold line, what to do
 * next under it, and the action that fixes it when there is one. An alert that screen readers
 * announce when it appears and whenever its text changes (the role alone announces nothing on
 * Android); the action stays its own stop.
 */
export function Notice({ tone, title, body, children, className, testID }: NoticeProps) {
  const message = body ? `${title}${/[.!?]$/.test(title) ? "" : "."} ${body}` : title;
  useEffect(() => announce(message), [message]);

  return (
    <View
      accessibilityRole="alert"
      style={continuousCorners}
      className={cx("gap-1 rounded-lg p-4", TONE[tone].surface, className)}
      testID={testID}
    >
      <Text className={cx("text-headline", TONE[tone].title)}>{title}</Text>
      {body ? <Text className={cx("text-callout", TONE[tone].body)}>{body}</Text> : null}
      {children ? <View className="mt-2 flex-row">{children}</View> : null}
    </View>
  );
}
